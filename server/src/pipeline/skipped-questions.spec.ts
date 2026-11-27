import type { PlanChatEntry } from '../contract/plan-chat';
import { DocumentRepository } from '../history/document.repository';
import { PlanChatStore } from '../history/plan-chat.store';
import { repositoryDatabase } from '../history/repository.spec-helpers';
import { RunRepository } from '../history/run.repository';
import { latest } from '../history/latest-document';
import { answered, renderAnswers } from '../steps/shared/answers';
import { OPEN_ITEM_KINDS, openItems } from '../steps/shared/open-items';
import { escalateToPerson, escalationLine } from './escalation';
import { questionFor } from '../steps/implement/split-questions';
import { closeEpicQuestions, closeSkippedQuestions } from './skipped-questions';

const REASON = 'this task was skipped';

const entry = (key: string, kind: 'question' | 'escalation'): PlanChatEntry => ({
  key,
  role: 'planner',
  kind,
  from: 'research',
  text: `text of ${key}`,
  at: '2026-01-01T00:00:00.000Z',
  state: 'pending',
});

async function world() {
  const db = await repositoryDatabase();
  const runs = db.app.get(RunRepository);
  const documents = db.app.get(DocumentRepository);
  const chat = db.app.get(PlanChatStore);
  await runs.openWaiting('run-1', '/target');
  const run = await runs.change('run-1', (row) => {
    row.currentStep = 'research';
  });
  const items = async () =>
    openItems(run, await documents.latestDocuments([run.id], [...OPEN_ITEM_KINDS]), []).map(
      (item) => `${item.id} => ${item.answer}`,
    );
  return { db, run, documents, chat, items, close: () => closeSkippedQuestions({ documents, chat }, run, REASON) };
}

describe('closeSkippedQuestions', () => {
  it('answers each open question with the reason and keeps the answers already given', async () => {
    const { db, run, documents, items, close } = await world();
    try {
      await documents.putDocument(run, 'questions', '- first?\n- second?\n');
      await documents.putDocument(run, 'answers', 'question: first?\nanswer: yes\n');

      await close();

      expect(await items()).toEqual(['first? => yes', `second? => ${REASON}`]);
    } finally {
      await db.close();
    }
  });

  it('takes a raised escalation and a pending one that was not raised, with the reason', async () => {
    const { db, run, documents, chat, items, close } = await world();
    try {
      const raised = entry('escalate-a', 'escalation');
      await chat.appendEntry(run.key, raised);
      await chat.appendEntry(run.key, entry('escalate-b', 'escalation'));
      await chat.appendEntry(run.key, entry('ask-1', 'question'));
      await escalateToPerson(documents, run, raised);

      await close();

      expect(await items()).toEqual([`${escalationLine(raised)} => ${REASON}`]);
      expect(await chat.pendingEscalations(run.key)).toEqual([]);
      expect(await chat.pendingQuestions(run.key)).toEqual([]);
      const { entries } = await chat.read(run.key);
      expect(entries.map((one) => [one.key, one.state, one.closed])).toEqual([
        ['escalate-a', 'taken', REASON],
        ['escalate-b', 'taken', REASON],
        ['ask-1', 'taken', REASON],
      ]);
    } finally {
      await db.close();
    }
  });

  it('writes nothing a second time', async () => {
    const { db, run, documents, close } = await world();
    try {
      await documents.putDocument(run, 'questions', '- first?\n');
      await close();
      const once = await documents.latestDocuments([run.id], ['answers']);

      await close();

      expect(await documents.latestDocuments([run.id], ['answers'])).toHaveLength(once.length);
      expect(answered(latest(once, 'answers') ?? '').get('first?')).toBe(REASON);
    } finally {
      await db.close();
    }
  });
});

describe('closeEpicQuestions', () => {
  const ASKED_AT = '2026-01-01T00:00:00.000Z';
  const line = (task: string, question: string) => questionFor(task, question, ASKED_AT);

  async function epic() {
    const db = await repositoryDatabase();
    const runs = db.app.get(RunRepository);
    const documents = db.app.get(DocumentRepository);
    const parent = await runs.openWaiting('epic-1', '/target');
    const part = await runs.openSubtask('epic-1-b', parent.id, 'b', parent.startedBy, parent.agents);
    const answers = async () => answered((await documents.latestBody('epic-1', 'answers')) ?? '');
    const close = (run = part) => closeEpicQuestions({ documents, runs }, run, REASON);
    return { db, runs, documents, parent, part, answers, close };
  }

  it("answers the part's open lines on its epic with the reason and keeps the other lines and answers", async () => {
    const { db, documents, parent, answers, close } = await epic();
    try {
      const own = [line('b', 'first?'), line('b', 'second?')];
      const sibling = line('c', 'third?');
      await documents.putDocument(parent, 'subtask_questions', `- ${[...own, sibling].join('\n- ')}\n`);
      await documents.putDocument(parent, 'answers', renderAnswers([[own[0], 'yes']]));

      await close();

      expect([...(await answers())]).toEqual([
        [own[0], 'yes'],
        [own[1], REASON],
      ]);
    } finally {
      await db.close();
    }
  });

  it('writes nothing when no line of the part is open, and nothing on a run with no epic', async () => {
    const { db, runs, documents, parent, answers, close } = await epic();
    try {
      await documents.putDocument(parent, 'subtask_questions', `- ${line('c', 'third?')}\n`);

      await close();
      await close((await runs.findRun('epic-1'))!);

      expect(await documents.latestBody('epic-1', 'answers')).toBeNull();
      expect(await answers()).toEqual(new Map());
    } finally {
      await db.close();
    }
  });
});
