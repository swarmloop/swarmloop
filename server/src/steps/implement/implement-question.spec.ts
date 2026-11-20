import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { agentFor } from '../../config/agents';
import { testEnv } from '../../config/env.spec-helpers';
import { sessionFileName, sessionHome } from '../../history/session-group';
import { agentStateDir } from '../../sandbox/sandbox-launch';
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

  describe('mayAsk', () => {
    const chat = {} as PlanChatStore;
    const env = testEnv();
    const roots: string[] = [];
    const root = async (): Promise<string> => {
      const dir = await mkdtemp(join(tmpdir(), 'swarmloop-may-ask-'));
      roots.push(dir);
      return dir;
    };
    afterEach(async () => {
      await Promise.all(roots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    });
    const run = (parentRunId: number | null, currentStep = 'implement') =>
      ({ key: 'PROJ-1', parentRunId, currentStep }) as RunEntity;

    /** A root where the plan step of PROJ-1 left its chat, as the planner does. */
    async function planned(): Promise<string> {
      const dir = await root();
      await mkdir(join(dir, 'data'), { recursive: true });
      await mkdir(agentStateDir(dir, 'PROJ-1', sessionHome('plan')), { recursive: true });
      const { runtime } = agentFor(env, run(null), 'plan');
      await writeFile(join(dir, 'data', sessionFileName('PROJ-1', 'plan')), JSON.stringify({ runtime, chatId: 'c1' }));
      return dir;
    }

    it('lets a run that has a planner chat ask', async () => {
      expect(await mayAsk(run(null), chat, { root: await planned(), env })).toBe(true);
    });

    it('does not let a run ask that never planned, such as a review of another branch', async () => {
      expect(await mayAsk(run(null, 'code-review'), chat, { root: await root(), env })).toBe(false);
    });

    it('does not let a run ask without a chat store', async () => {
      expect(await mayAsk(run(null), undefined, { root: await planned(), env })).toBe(false);
    });

    it('lets a subtask ask its parent only at the steps that ask', async () => {
      // A subtask asks its own planner, like any run: it needs the plan chat its own plan step left.
      const place = { root: await planned(), env };
      expect(await mayAsk(run(4), chat, place)).toBe(true);
      expect(await mayAsk(run(4, 'implement-improve'), chat, place)).toBe(true);
      expect(await mayAsk(run(4, 'code-review'), chat, place)).toBe(false);
      expect(await mayAsk(run(4), chat, { root: await root(), env })).toBe(false);
    });
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
