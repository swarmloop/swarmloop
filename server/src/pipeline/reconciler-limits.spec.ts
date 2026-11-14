import 'reflect-metadata';
import { ERROR_CODES } from '../contract/error-codes';
import { writeRunState } from '../history/run-state';
import { RESUME_AFTER_RESET_MS } from '../history/runtime-cooldown.repository';
import { credentialDatabase } from '../testing/credential-database.spec-helpers';
import { Reconciler } from './reconciler';

const MINUTE = 60_000;

async function setup() {
  const fixture = await credentialDatabase();
  const accept = jest.fn().mockResolvedValue(undefined);
  const reconciler = new Reconciler(
    fixture.runs,
    {} as never,
    {} as never,
    fixture.config,
    fixture.db.clock,
    { accept } as never,
    {} as never,
    fixture.cooldowns,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    undefined,
    fixture.credentials,
  );
  /** A run that waits for a limit, as a limited step leaves it. */
  const waiting = async (key: string, startedBy: string | null, parentId?: number) => {
    const run = await fixture.run(key, startedBy, parentId);
    writeRunState(run, {
      status: 'waiting',
      currentStep: 'implement',
      reason: { code: ERROR_CODES.RUNTIME_LIMIT, message: 'limited' },
    });
    return fixture.runs.saveRun(run);
  };
  return { ...fixture, accept, reconciler, waiting };
}

describe('reconciler and the limits of a credential', () => {
  it("does not resume a run while its own credential cools, even when another person's has ended", async () => {
    const { db, cooldowns, accept, reconciler, waiting } = await setup();
    try {
      const now = db.clock.now();
      await cooldowns.set({ runtime: 'claude', credential: 'ann' }, now + 60 * MINUTE, false);
      await cooldowns.set({ runtime: 'claude', credential: 'bob' }, now + 10 * MINUTE, false);
      await cooldowns.set({ runtime: 'codex', credential: 'env' }, now + 90 * MINUTE, false);
      const run = await waiting('A-1', 'ann');
      db.clock.advance(30 * MINUTE);
      await reconciler.resumeLimited();
      expect(accept).not.toHaveBeenCalled();
      db.clock.advance(30 * MINUTE);
      await reconciler.resumeLimited();
      expect(accept).toHaveBeenCalledWith('resume', run.key, {}, { idempotencyKey: `limit-${run.revision}` });
    } finally {
      await db.close();
    }
  });

  it("resumes a subtask by its parent's starter", async () => {
    const { db, cooldowns, accept, reconciler, run, waiting } = await setup();
    try {
      const now = db.clock.now();
      await cooldowns.set({ runtime: 'claude', credential: 'ann' }, now + 60 * MINUTE, false);
      await cooldowns.set({ runtime: 'codex', credential: 'env' }, now + 60 * MINUTE, false);
      const parent = await run('A-1', 'ann');
      const subtask = await waiting('A-1-a', null, parent.id);
      db.clock.advance(30 * MINUTE);
      await reconciler.resumeLimited();
      expect(accept).not.toHaveBeenCalled();
      db.clock.advance(30 * MINUTE);
      await reconciler.resumeLimited();
      expect(accept).toHaveBeenCalledWith('resume', subtask.key, {}, expect.anything());
    } finally {
      await db.close();
    }
  });

  it('resumes an env-only run at the end, or a minute after a reset the provider named', async () => {
    const { db, cooldowns, accept, reconciler, waiting } = await setup();
    try {
      const now = db.clock.now();
      await cooldowns.set({ runtime: 'claude', credential: 'env' }, now + 60 * MINUTE, true);
      await cooldowns.set({ runtime: 'codex', credential: 'env' }, now + 120 * MINUTE, false);
      await waiting('C-1', null);
      db.clock.advance(60 * MINUTE);
      await reconciler.resumeLimited();
      expect(accept).not.toHaveBeenCalled();
      db.clock.advance(RESUME_AFTER_RESET_MS);
      await reconciler.resumeLimited();
      expect(accept).toHaveBeenCalledTimes(1);
    } finally {
      await db.close();
    }
  });
});
