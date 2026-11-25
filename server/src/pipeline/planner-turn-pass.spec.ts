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
});
