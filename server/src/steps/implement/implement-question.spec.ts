import type { RunEntity } from '../../history/entities';
import { PlanChatStore } from '../../history/plan-chat.store';
import { repositoryDatabase } from '../../history/repository.spec-helpers';
import { RunRepository } from '../../history/run.repository';
import { deriveState } from '../../history/run-state';
import {
  answerFollowUp,
  answerSection,
  assumedLine,
  mayAsk,
  readAnswer,
  takeAnswer,
  waitForPlanner,
  withAssumed,
} from './implement-question';

const QUESTION = 'Keep the cursor or the page number?';

/** A database with one waiting run, for a step that asks the planner. */
async function asking() {
  const db = await repositoryDatabase();
  const run = await db.app.get(RunRepository).openWaiting('PROJ-1', '/target');
  const chat = db.app.get(PlanChatStore);
  const ask = (attemptId: string) =>
    waitForPlanner(run, { chat, clock: db.clock, step: 'implement', attemptId, startedAt: 'T0', question: QUESTION });
  return { db, run, chat, ask };
}

describe('a step that asks the planner', () => {
  it('waits with the planner reason, commits nothing and records one question for the attempt', async () => {
    const { db, run, chat, ask } = await asking();
    try {
      const result = await ask('attempt-1');
      await ask('attempt-1');

      expect(result.route).toEqual({
        to: 'wait',
        code: 'ASKS_PLANNER',
        reason: 'implement is waiting for the planner',
      });
      expect(result.outputs).toEqual([]);
      const questions = await chat.pendingQuestions(run.key);
      expect(questions).toMatchObject([{ key: 'ask-implement-attempt-1', from: 'implement', text: QUESTION }]);
      expect(await chat.pending(run.key)).toEqual([]);
      const stateReason = JSON.stringify({ code: 'ASKS_PLANNER', message: 'implement is waiting for the planner' });
      expect(deriveState({ ...run, status: 'waiting', stateReason })).toMatchObject({
        state: 'waiting',
        reason: { code: 'ASKS_PLANNER' },
      });
    } finally {
      await db.close();
    }
  });

  it('reads the planner answer once, after the step took it', async () => {
    const { db, run, chat } = await asking();
    try {
      await chat.appendEntry(run.key, {
        key: 'answer-ask-implement-attempt-1',
        role: 'planner',
        kind: 'answer',
        from: 'implement',
        text: 'Cursor, as in the brief.',
        at: '2026-01-01T00:00:00.000Z',
        state: 'pending',
      });

      const answer = await readAnswer(chat, run.key, 'implement');
      expect(answer?.text).toBe('Cursor, as in the brief.');
      expect(await readAnswer(chat, run.key, 'implement')).not.toBeNull();
      await takeAnswer(chat, run.key, answer);
      expect(await readAnswer(chat, run.key, 'implement')).toBeNull();
      expect(await readAnswer(undefined, run.key, 'implement')).toBeNull();
    } finally {
      await db.close();
    }
  });

  it('lets a run ask when it has a chat, and a subtask only at the steps that ask its parent', () => {
    const chat = {} as PlanChatStore;
    expect(mayAsk({ parentRunId: null } as RunEntity, chat)).toBe(true);
    expect(mayAsk({ parentRunId: 4, currentStep: 'implement' } as RunEntity, chat)).toBe(true);
    expect(mayAsk({ parentRunId: 4, currentStep: 'implement-improve' } as RunEntity, chat)).toBe(true);
    expect(mayAsk({ parentRunId: 4, currentStep: 'code-review' } as RunEntity, chat)).toBe(false);
    expect(mayAsk({ parentRunId: null } as RunEntity, undefined)).toBe(false);
  });
});

describe('the prompt after an answer', () => {
  const answer = { text: ' Cursor, as in the brief. ' } as Parameters<typeof answerSection>[0];

  it('names the planner answer and tells the step to decide any further choice itself', () => {
    const text = answerFollowUp(answer, 'RESULT TEXT');
    expect(text).toMatch(/^Answer from the planner:\nCursor, as in the brief\./);
    expect(text).toContain('Decide any further open choice yourself');
    expect(text.endsWith('RESULT TEXT')).toBe(true);
    expect(answerSection(answer).heading).toBe('Answer from the planner');
  });

  it('writes a further question as one assumed: line of the handoff, and nothing without one', () => {
    expect(assumedLine('Which\n  page size?')).toBe('assumed: Which page size?');
    expect(withAssumed('done\n', QUESTION)).toBe(`done\nassumed: ${QUESTION}`);
    expect(withAssumed('done\n', undefined)).toBe('done\n');
    expect(withAssumed('done\n', '  ')).toBe('done\n');
  });
});
