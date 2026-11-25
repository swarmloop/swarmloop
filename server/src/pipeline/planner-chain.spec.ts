import { storeRun } from '../testing/store-run.spec-helpers';
import { PlanChatStore } from '../history/plan-chat.store';
import { DocumentRepository } from '../history/document.repository';
import { repositoryDatabase } from '../history/repository.spec-helpers';
import { RunRepository } from '../history/run.repository';
import { storedState } from '../history/run-state';
import { handoffText } from '../steps/shared/handoff';
import { holdServices, seedBacklogTask } from '../steps/shared/question-holds.spec-helpers';
import type { PlanConversation } from '../steps/shared/plan-conversation';
import type { Escalated } from '../steps/shared/subtask-ops';
import { PlannerChain } from './planner-chain';

const AT = '2026-01-01T00:00:00.000Z';
const question = { from: 'implement', text: 'a needs b: which retry policy wins' };

/** What a planner turn gives: a reply, an escalation, or no usable reply (null). */
type Turn = { reply: string; escalate?: string } | null;

async function setup() {
  const db = await repositoryDatabase();
  const runs = db.app.get(RunRepository);
  const documents = db.app.get(DocumentRepository);
  const chat = new PlanChatStore(runs, documents);
  const turns: Turn[] = [];
  const epicAnswers: (string | Escalated | null)[] = [];
  const words: (string | undefined)[] = [];
  const conversation = {
    chat,
    clock: { iso: () => AT, now: () => Date.parse(AT) },
    visit: () => {
      const turn = turns.shift() ?? null;
      return Promise.resolve(turn ? { value: turn } : null);
    },
  } as unknown as PlanConversation;
  const chain = new PlannerChain(
    {
      askAbout: () => Promise.resolve(epicAnswers.shift() ?? null),
      // What the real hand-up leaves: the task's question among the questions of its parent's implement step.
      handUp: async (parent, _task, text, said) => {
        words.push(said);
        await documents.putDocument(parent, 'subtask_questions', `- ${text}\n`);
      },
    },
    conversation,
    documents,
    runs,
    holdServices(db.app, db.clock).holds,
  );
  const epic = await runs.openWaiting('EPIC-1', '/target');
  const task = await runs.openSubtask('EPIC-1-a', epic.id, 'a');
  const alone = await runs.openWaiting('ALONE-1', '/target');
  return { db, runs, documents, chat, turns, epicAnswers, words, chain, epic, task, alone };
}

describe('PlannerChain', () => {
  it('asks the start level first and returns its answer without starting the run', async () => {
    const h = await setup();
    try {
      h.turns.push({ reply: 'Keep it in b.' });

      const asked = await h.chain.askUp(h.alone, question, 0);

      expect(asked).toEqual({ asked: 'run-planner', level: 0, answer: 'Keep it in b.' });
      expect((await h.runs.findRun('ALONE-1'))?.status).toBe('waiting');
      expect(await h.chain.openQuestion(h.alone)).toBeNull();
    } finally {
      await h.db.close();
    }
  });

  it('moves the same question one level up when it is asked again after an answer', async () => {
    const h = await setup();
    try {
      h.epicAnswers.push('First decision.', 'Second decision.');
      const first = await h.chain.askUp(h.task, question, 1);
      const again = await h.chain.askUp(h.task, question, 1);

      expect(first).toEqual({ asked: 'epic-planner', level: 1, answer: 'First decision.' });
      expect(again).toEqual({ asked: 'starter', level: 2, answer: null });
    } finally {
      await h.db.close();
    }
  });

  it('moves the question up when a planner gives no usable reply', async () => {
    const h = await setup();
    try {
      h.turns.push(null);
      h.epicAnswers.push('The epic decides.');

      const asked = await h.chain.askUp(h.task, question, 0);

      expect(asked).toEqual({ asked: 'epic-planner', level: 1, answer: 'The epic decides.' });
    } finally {
      await h.db.close();
    }
  });

  it('sends an escalation straight to the starter', async () => {
    const h = await setup();
    try {
      h.turns.push({ reply: '', escalate: 'Only the person can choose.' });
      h.epicAnswers.push('Never asked.');

      const asked = await h.chain.askUp(h.alone, question, 0);

      expect(asked).toEqual({ asked: 'starter', level: 1, answer: null });
    } finally {
      await h.db.close();
    }
  });

  it('sends an escalation of an epic-level planner straight to the starter with its words', async () => {
    const h = await setup();
    try {
      h.epicAnswers.push({ escalate: 'The person picks the retry policy.' }, 'Never asked.');

      const asked = await h.chain.askUp(h.task, question, 1);

      expect(asked).toEqual({ asked: 'starter', level: 2, answer: null });
      expect(h.words).toEqual(['The person picks the retry policy.']);
      expect(h.epicAnswers).toEqual(['Never asked.']);
      expect(handoffText(await h.documents.latestBody('EPIC-1-a', 'handoff'))).toBe('');
    } finally {
      await h.db.close();
    }
  });

  it('merges the decision of an ancestor into the handoff of the asking run', async () => {
    const h = await setup();
    try {
      h.epicAnswers.push('Keep it in b.');

      await h.chain.askUp(h.task, question, 1);

      expect(handoffText(await h.documents.latestBody('EPIC-1-a', 'handoff'))).toBe('## implement\nKeep it in b.\n');
    } finally {
      await h.db.close();
    }
  });

  it('puts a question at the starter among the questions of the run with the person wait, and asks it once', async () => {
    const h = await setup();
    try {
      h.turns.push(null);

      const asked = await h.chain.askUp(h.alone, question, 0);
      const again = await h.chain.askUp(h.alone, question, 0);

      expect(asked).toEqual({ asked: 'starter', level: 1, answer: null });
      expect(again).toEqual(asked);
      const questions = (await h.documents.latestBody('ALONE-1', 'questions')) ?? '';
      expect(questions.match(/which retry policy wins/g)).toHaveLength(1);
      const run = (await h.runs.findRun('ALONE-1'))!;
      expect(storedState(run).reason?.code).toBe('NEEDS_ANSWERS');
    } finally {
      await h.db.close();
    }
  });

  it('leaves the question no level answers with the backlog planner when the run is a backlog task run', async () => {
    const h = await setup();
    try {
      await seedBacklogTask(h.db.app, 'ALONE-1');
      await storeRun(h.runs, { ...h.alone, currentStep: 'implement' });
      h.turns.push(null);

      await h.chain.askUp(h.alone, question, 0);

      const run = (await h.runs.findRun('ALONE-1'))!;
      expect(storedState(run)).toMatchObject({ state: 'waiting', reason: { code: 'ASKS_PLANNER' } });
    } finally {
      await h.db.close();
    }
  });

  it('leaves the question a subtask hands up to a backlog epic with the backlog planner', async () => {
    const h = await setup();
    try {
      await seedBacklogTask(h.db.app, 'EPIC-1');
      await storeRun(h.runs, { ...h.epic, split: true, currentStep: 'implement' });
      h.epicAnswers.push(null);

      await h.chain.askUp(h.task, question, 1);

      const epic = (await h.runs.findRun('EPIC-1'))!;
      expect(storedState(epic)).toMatchObject({ state: 'waiting', reason: { code: 'ASKS_PLANNER' } });
    } finally {
      await h.db.close();
    }
  });
});
