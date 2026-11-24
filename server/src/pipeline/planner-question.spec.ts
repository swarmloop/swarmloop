import { PlanChatStore } from '../history/plan-chat.store';
import { DocumentRepository } from '../history/document.repository';
import { repositoryDatabase } from '../history/repository.spec-helpers';
import { RunRepository } from '../history/run.repository';
import type { PlanChatEntry } from '../contract/plan-chat';
import type { PlanConversation } from '../steps/shared/plan-conversation';
import { askPlanner, readPersonAnswer } from './planner-question';

const AT = '2026-01-01T00:00:00.000Z';

/** One planner turn that answers with `value` and keeps the schema its reply was asked for. */
async function setup(value: object) {
  const db = await repositoryDatabase();
  const runs = db.app.get(RunRepository);
  const chat = new PlanChatStore(runs, db.app.get(DocumentRepository));
  const asked: string[][] = [];
  const conversation = {
    visit: (_opened: unknown, _prompt: unknown, definition: { schema: { describe(): { keys: object } } }) => {
      asked.push(Object.keys(definition.schema.describe().keys));
      return Promise.resolve({ value });
    },
  } as unknown as PlanConversation;
  const run = await runs.openWaiting('ASK-1', '/target');
  const deps = { chat, conversation, clock: { iso: () => AT, now: () => Date.parse(AT) } };
  return { db, deps, run, chat, asked };
}

const question = (about?: 'finding'): PlanChatEntry => ({
  key: 'ask-code-review-quality-1',
  role: 'planner',
  kind: 'question',
  from: 'code-review-quality',
  text: 'Which one is meant?',
  at: AT,
  state: 'pending',
  ...(about ? { about } : {}),
});

describe('a planner answers a step question', () => {
  it('records the decision and the instruction on the answer to a question about a finding', async () => {
    const h = await setup({ reply: 'It stands.', finding: 'holds', instruction: ' Fix the parser. ' });
    try {
      const outcome = await askPlanner(h.deps, h.run, question('finding'));

      expect(outcome).toEqual({ kind: 'answered' });
      expect(h.asked[0]).toEqual(expect.arrayContaining(['finding', 'instruction']));
      const { entries } = await h.chat.read(h.run.key);
      expect(entries.find((entry) => entry.kind === 'answer')).toMatchObject({
        key: 'answer-ask-code-review-quality-1',
        text: 'It stands.',
        finding: 'holds',
        instruction: 'Fix the parser.',
      });
    } finally {
      await h.db.close();
    }
  });

  it('leaves the answer to any other question as it was', async () => {
    const h = await setup({ reply: 'Use the cursor.' });
    try {
      await askPlanner(h.deps, h.run, question());

      expect(h.asked[0]).not.toContain('finding');
      const { entries } = await h.chat.read(h.run.key);
      const answer = entries.find((entry) => entry.kind === 'answer');
      expect(answer).toMatchObject({ text: 'Use the cursor.' });
      expect(answer).not.toHaveProperty('finding');
      expect(answer).not.toHaveProperty('instruction');
    } finally {
      await h.db.close();
    }
  });

  it('records the decision when it reads the answer of the person to an escalated finding', async () => {
    const h = await setup({ reply: 'The person ruled it out.', finding: 'ruled-out' });
    try {
      const escalation = { ...question(), key: 'escalate-ask-code-review-quality-1', kind: 'escalation' as const };

      await readPersonAnswer(h.deps, h.run, escalation, question('finding'), 'maria');

      const { entries } = await h.chat.read(h.run.key);
      expect(entries.find((entry) => entry.kind === 'answer')).toMatchObject({ finding: 'ruled-out' });
    } finally {
      await h.db.close();
    }
  });
});
