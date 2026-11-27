import 'reflect-metadata';
import { storeRun } from '../testing/store-run.spec-helpers';
import { ERROR_CODES } from '../contract/error-codes';
import { writeRunState } from '../history/run-state';
import { RESUME_AFTER_RESET_MS } from '../history/runtime-cooldown.repository';
import { credentialDatabase } from '../testing/credential-database.spec-helpers';
import { AgentDoor } from '../steps/shared/agent-door';
import { Reconciler } from './reconciler';
import { StartGate } from './start-gate';

const MINUTE = 60_000;
const MACHINE = { by: 'machine', level: null };

async function setup() {
  const fixture = await credentialDatabase();
  const accepted: unknown[][] = [];
  const accept = async (...call: unknown[]) => {
    accepted.push(call);
    return { replayed: false };
  };
  const none = undefined as never;
  const door = new AgentDoor(none, fixture.runs, none, none, none, none, none, none, none);
  /** Whether the spend of every run is under MAX_RUN_USD now, and the attempt its last visit had. */
  const spend = { under: false };
  const visits = { listStats: async () => [{ attemptId: 'attempt-7' }] };
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
    visits as never,
    {} as never,
    {} as never,
    new StartGate({ accept } as never, { underSpendLimit: async () => spend.under } as never, {} as never, door),
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
    return storeRun(fixture.runs, run);
  };
  /** A run that a step of the machine left blocked at the spend limit. */
  const blockedOnSpend = async (key: string) => {
    const run = await fixture.run(key, null);
    writeRunState(run, {
      status: 'blocked',
      currentStep: 'implement',
      reason: { code: ERROR_CODES.SPEND_LIMIT, message: 'spent' },
    });
    return storeRun(fixture.runs, run);
  };
  return { ...fixture, accepted, reconciler, waiting, blockedOnSpend, spend };
}

describe('reconciler and the limits of a credential', () => {
  it("does not resume a run while its own credential cools, even when another person's has ended", async () => {
    const { db, cooldowns, accepted, reconciler, waiting } = await setup();
    try {
      const now = db.clock.now();
      await cooldowns.set({ runtime: 'claude', credential: 'ann' }, now + 60 * MINUTE, false);
      await cooldowns.set({ runtime: 'claude', credential: 'bob' }, now + 10 * MINUTE, false);
      await cooldowns.set({ runtime: 'codex', credential: 'env' }, now + 90 * MINUTE, false);
      const run = await waiting('A-1', 'ann');
      db.clock.advance(30 * MINUTE);
      await reconciler.resumeOutsideWaits();
      expect(accepted).toEqual([]);
      db.clock.advance(30 * MINUTE);
      await reconciler.resumeOutsideWaits();
      expect(accepted).toEqual([['resume', run.key, MACHINE, { idempotencyKey: `limit-${run.revision}` }]]);
    } finally {
      await db.close();
    }
  });

  it("resumes a subtask by its parent's starter", async () => {
    const { db, cooldowns, accepted, reconciler, run, waiting } = await setup();
    try {
      const now = db.clock.now();
      await cooldowns.set({ runtime: 'claude', credential: 'ann' }, now + 60 * MINUTE, false);
      await cooldowns.set({ runtime: 'codex', credential: 'env' }, now + 60 * MINUTE, false);
      const parent = await run('A-1', 'ann');
      const subtask = await waiting('A-1-a', null, parent.id);
      db.clock.advance(30 * MINUTE);
      await reconciler.resumeOutsideWaits();
      expect(accepted).toEqual([]);
      db.clock.advance(30 * MINUTE);
      await reconciler.resumeOutsideWaits();
      expect(accepted).toEqual([['resume', subtask.key, MACHINE, expect.anything()]]);
    } finally {
      await db.close();
    }
  });

  it('resumes an env-only run at the end, or a minute after a reset the provider named', async () => {
    const { db, cooldowns, accepted, reconciler, waiting } = await setup();
    try {
      const now = db.clock.now();
      await cooldowns.set({ runtime: 'claude', credential: 'env' }, now + 60 * MINUTE, true);
      await cooldowns.set({ runtime: 'codex', credential: 'env' }, now + 120 * MINUTE, false);
      await waiting('C-1', null);
      db.clock.advance(60 * MINUTE);
      await reconciler.resumeOutsideWaits();
      expect(accepted).toEqual([]);
      db.clock.advance(RESUME_AFTER_RESET_MS);
      await reconciler.resumeOutsideWaits();
      expect(accepted).toHaveLength(1);
    } finally {
      await db.close();
    }
  });

  it('resumes a run blocked at the spend limit once, when its spend is under MAX_RUN_USD again', async () => {
    const { db, config, accepted, reconciler, blockedOnSpend, spend } = await setup();
    try {
      const run = await blockedOnSpend('S-1');
      await reconciler.resumeUnderSpendLimit();
      expect(accepted).toEqual([]);

      spend.under = true;
      await reconciler.resumeUnderSpendLimit();
      const resume = ['resume', run.key, MACHINE, { idempotencyKey: `spend-attempt-7-${config.env.MAX_RUN_USD}` }];
      expect(accepted).toEqual([resume]);

      // A pass again names the same event, so the command store replays it.
      await reconciler.resumeUnderSpendLimit();
      expect(accepted).toEqual([resume, resume]);
    } finally {
      await db.close();
    }
  });

  it('does not resume a run that waits for something else than the spend limit', async () => {
    const { db, accepted, reconciler, waiting, spend } = await setup();
    try {
      await waiting('S-2', null);
      spend.under = true;
      await reconciler.resumeUnderSpendLimit();
      expect(accepted).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
