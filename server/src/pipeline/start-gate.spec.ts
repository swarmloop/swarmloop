import 'reflect-metadata';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { seededBoot } from '../api/runs-boot.spec-helpers';
import { REASON } from '../contract/run-state';
import { CommandRepository } from '../history/command.repository';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { save } from '../testing/runs.spec-helpers';
import { CommandService } from './command.service';
import { PERSON_RESUME, startByOf } from './resume-sender';
import { StartGate } from './start-gate';

async function setup() {
  const app = await seededBoot(await mkdtemp(join(tmpdir(), 'swarmloop-start-gate-')));
  const runs = app.get(RunRepository);
  app.get(CommandService).register('resume', async () => ({ key: 'proj-1', status: 'started' }));
  const run = await save(runs, 'proj-1', 'implement', 'waiting');
  const stop = async () => {
    writeRunState(run, { status: 'blocked', reason: { code: REASON.stopped, message: 'Stopped.' } });
    await runs.saveRun(run);
  };
  const stored = async () => (await app.get(CommandRepository).listForRun(run.id)).filter((c) => c.type === 'resume');
  return { app, gate: app.get(StartGate), run, stop, stored };
}

describe('StartGate', () => {
  it('resumes a run that waits, and answers replayed for the same event', async () => {
    const { app, gate, run, stored } = await setup();
    try {
      expect(await gate.resume(run, { by: 'machine', event: 'limit-1' })).toBe('accepted');
      expect(await gate.resume(run, { by: 'machine', event: 'limit-1' })).toBe('replayed');
      expect(await stored()).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('stores who asks, with the level of a planner, in the payload', async () => {
    const { app, gate, run, stored } = await setup();
    try {
      await gate.resume(run, { by: 'machine', event: 'a' });
      await gate.resume(run, { by: 'planner', level: 2, event: 'b', payload: { stalledAt: 'x' } });

      const payloads = (await stored()).map((command) => JSON.parse(command.payload));
      expect(payloads).toEqual([
        { by: 'machine', level: null },
        { by: 'planner', level: 2, stalledAt: 'x' },
      ]);
    } finally {
      await app.close();
    }
  });

  it('does not resume a run a person stopped for the machine or a planner, and stores no command', async () => {
    const { app, gate, run, stop, stored } = await setup();
    try {
      await stop();

      expect(await gate.stopped(run)).toBe(true);
      expect(await gate.resume(run, { by: 'machine', event: 'a' })).toBe('stopped');
      expect(await gate.resume(run, { by: 'planner', level: 1, event: 'b' })).toBe('stopped');
      expect(await stored()).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it("resumes a stopped run for a person and for a planner on a person's message", async () => {
    const { app, gate, run, stop, stored } = await setup();
    try {
      await stop();

      expect(await gate.resume(run, { by: 'person', event: 'a' })).toBe('accepted');
      expect(await gate.resume(run, { by: 'planner', level: 0, event: 'b', payload: { ...PERSON_RESUME } })).toBe(
        'accepted',
      );

      const payloads = (await stored()).map((command) => JSON.parse(command.payload));
      expect(payloads).toEqual([
        { by: 'person', level: null },
        { by: 'person', level: 0 },
      ]);
    } finally {
      await app.close();
    }
  });
});

describe('startByOf', () => {
  const of = (payload: string) => startByOf({ payload });

  it('reads a person, a planner with its level, and the machine', () => {
    expect(of(JSON.stringify(PERSON_RESUME))).toEqual({ by: 'person', level: null });
    expect(of('{"by":"planner","level":3}')).toEqual({ by: 'planner', level: 3 });
    expect(of('{"by":"planner"}')).toEqual({ by: 'planner', level: null });
    expect(of('{}')).toEqual({ by: 'machine', level: null });
    expect(of('{"by":"robot"}')).toEqual({ by: 'machine', level: null });
    expect(of('not json')).toEqual({ by: 'machine', level: null });
  });
});
