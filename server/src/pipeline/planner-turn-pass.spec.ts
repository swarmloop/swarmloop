import { ERROR_CODES } from '../contract/error-codes';
import { HostUnavailable } from '../core/swarmloop-error';
import { repositoryDatabase } from '../history/repository.spec-helpers';
import { RunRepository } from '../history/run.repository';
import { storedState } from '../history/run-state';
import type { AgentDoor } from '../steps/shared/agent-door';
import type { HopGate } from './hop-gate';
import { PlannerTurnPass } from './planner-turn-pass';
import type { PlannerTurns } from './planner-turns';

const KEY = 'PROJ-1';

describe('PlannerTurnPass', () => {
  it('a question turn whose model host did not answer leaves the run waiting with HOST_UNAVAILABLE and its retryAt, and ends the drive', async () => {
    const db = await repositoryDatabase();
    try {
      const runs = db.app.get(RunRepository);
      await runs.openWaiting(KEY, '/target');
      const down = new HostUnavailable('api.anthropic.com', 'API Error: 502', '2026-01-01T00:05:00.000Z');
      const turns = {
        next: async () => 'question',
        raise: async () => false,
        answer: () => Promise.reject(down),
      } as unknown as PlannerTurns;
      const door = { takeRefusal: () => null } as unknown as AgentDoor;
      const asked: string[] = [];
      const hop = {
        askChain: async (key: string) => {
          asked.push(key);
          return { message: 'asked' };
        },
      } as unknown as HopGate;
      const pass = new PlannerTurnPass(runs, turns, door, hop, () => Promise.reject(new Error('no plan step')));

      await expect(pass.run(KEY, new Set())).resolves.toEqual({ message: down.message });

      const run = (await runs.findRun(KEY))!;
      expect(run.status).toBe('waiting');
      expect(storedState(run).reason).toEqual({
        code: ERROR_CODES.HOST_UNAVAILABLE,
        message: down.message,
        retryAt: down.retryAt,
      });
      expect(asked).toEqual([]);
    } finally {
      await db.close();
    }
  });

  describe('an escalation a step wrote', () => {
    const passOf = async (turns: Partial<Record<keyof PlannerTurns, unknown>>) => {
      const db = await repositoryDatabase();
      const runs = db.app.get(RunRepository);
      await runs.openWaiting(KEY, '/target');
      const door = { takeRefusal: () => null } as unknown as AgentDoor;
      const pass = new PlannerTurnPass(runs, turns as unknown as PlannerTurns, door, {} as HopGate, async () => ({
        exitCode: 0,
        message: 'ok',
      }));
      return { db, runs, pass };
    };

    it('ends the pass before any message is taken when the run raised one', async () => {
      const taken: string[] = [];
      const { db, pass } = await passOf({
        raise: async () => true,
        next: async () => 'message',
        take: async () => {
          taken.push('take');
          return 'kept';
        },
      });
      try {
        await expect(pass.run(KEY, new Set())).resolves.toBeNull();
        expect(taken).toEqual([]);
      } finally {
        await db.close();
      }
    });

    it('leaves the run waiting at its step when a changing reply escalated, and goes to plan-improve otherwise', async () => {
      for (const raised of [true, false]) {
        let first = true;
        const { db, runs, pass } = await passOf({
          raise: async () => (first ? ((first = false), false) : raised),
          next: async () => 'message',
          take: async () => 'changed',
        });
        try {
          const result = await pass.run(KEY, new Set());
          expect(result).toEqual(raised ? null : { step: 'plan-improve' });
          expect((await runs.findRun(KEY))!.status).toBe('waiting');
        } finally {
          await db.close();
        }
      }
    });
  });
});
