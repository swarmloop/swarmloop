import { RuntimeLimit } from '../../core/swarmloop-error';
import type { RunEntity } from '../../history/entities';
import { credentialDatabase } from '../../testing/credential-database.spec-helpers';
import { cooldownKeys, LimitFailover } from './limit-failover';

const MINUTE = 60_000;
const limit = (resetsAt?: string) =>
  ({ limit: { window: '5-hour', resetsAt }, startedAt: '', finishedAt: '' }) as never;

async function setup() {
  const fixture = await credentialDatabase();
  const failover = new LimitFailover(
    fixture.config,
    fixture.db.clock,
    fixture.cooldowns,
    { finishVisit: async () => undefined } as never,
    fixture.runs,
    fixture.credentials,
  );
  const request = (run: RunEntity, runtime: 'claude' | 'codex' = 'claude') =>
    ({ run, step: 'implement', mode: 'agent', runtime, model: `m-${runtime}`, prompt: 'p' }) as never;
  return { ...fixture, failover, request };
}

describe('limit failover per credential', () => {
  it("cools only the limited person's credential, so another person's run goes on", async () => {
    const { db, failover, request, run, cooldowns } = await setup();
    try {
      const ann = await run('A-1', 'ann');
      const bob = await run('B-1', 'bob');
      const moved = await failover.limited(request(ann), limit());
      expect(moved).toMatchObject({ runtime: 'codex' });
      expect(await cooldowns.cooling(db.clock.now(), [{ runtime: 'claude', credential: 'ann' }])).toEqual(
        new Set(['claude']),
      );
      expect((await cooldowns.cooling(db.clock.now(), [{ runtime: 'claude', credential: 'bob' }])).size).toBe(0);
      expect(await failover.start(request(bob))).toMatchObject({ runtime: 'claude' });
      expect(await failover.start(request(ann))).toMatchObject({ runtime: 'codex' });
    } finally {
      await db.close();
    }
  });

  it("keeps the server's own credential apart from a person's", async () => {
    const { db, failover, request, run } = await setup();
    try {
      await failover.limited(request(await run('A-1', 'ann')), limit());
      expect(await failover.start(request(await run('C-1', null)))).toMatchObject({ runtime: 'claude' });
    } finally {
      await db.close();
    }
  });

  it("gives a subtask the key of its parent's starter", async () => {
    const { db, runs, credentials, run } = await setup();
    try {
      const parent = await run('A-1', 'ann');
      const subtask = await run('A-1-a', null, parent.id);
      expect(await cooldownKeys(subtask, ['claude', 'codex'], runs, credentials)).toEqual([
        { runtime: 'claude', credential: 'ann' },
        { runtime: 'codex', credential: 'env' },
      ]);
    } finally {
      await db.close();
    }
  });

  it("waits only until the earliest end of the run's own credential", async () => {
    const { db, failover, request, run } = await setup();
    try {
      const now = db.clock.now();
      await failover.limited(request(await run('B-1', 'bob')), limit(new Date(now + 10 * MINUTE).toISOString()));
      const ann = await run('A-1', 'ann');
      await failover.limited(request(ann), limit(new Date(now + 120 * MINUTE).toISOString()));
      const error = await failover.limited(request(ann, 'codex'), limit()).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(RuntimeLimit);
      expect((error as RuntimeLimit).resumesAt).toBe(new Date(now + 60 * MINUTE).toISOString());
    } finally {
      await db.close();
    }
  });
});
