import { SystemClock } from '../../core/clock';
import { markEntered } from '../../core/entered-marks';
import type { ServerStallDraft, ServerStallRepository } from '../../history/server-stall.repository';
import type { DockerMachine } from '../../sandbox/docker-machine';
import { RunningWork } from '../../sandbox/running-work';
import type { SandboxService } from '../../sandbox/sandbox.service';
import { ServerStallWatch } from './server-stall-watch';
import type { TickSource } from './tick-worker';

class FakeTicks implements TickSource {
  count = 0;
  closed = false;
  ticks(): number {
    return this.count;
  }
  close(): Promise<void> {
    this.closed = true;
    return Promise.resolve();
  }
}

const MACHINE: DockerMachine = { cpus: 6, memoryBytes: 8_000_000_000 };

function setup(known: DockerMachine | null = MACHINE, failFirst = false) {
  const machine = known ?? undefined;
  const work = new RunningWork();
  const rows: ServerStallDraft[] = [];
  let failed = !failFirst;
  const sandbox = {
    work,
    machine: () => Promise.resolve(machine),
    knownMachine: () => machine,
  } as unknown as SandboxService;
  const repository = {
    record: (draft: ServerStallDraft) => {
      if (!failed) {
        failed = true;
        return Promise.reject(new Error('disk full'));
      }
      rows.push(draft);
      return Promise.resolve();
    },
  } as unknown as ServerStallRepository;
  const watch = new ServerStallWatch(new SystemClock(), sandbox, repository);
  const ticks = new FakeTicks();
  return { watch, ticks, work, rows };
}

/** One main-loop tick that comes `gapMs` after the last one. */
function tickAfter(gapMs: number): void {
  jest.setSystemTime(Date.now() + gapMs);
  jest.advanceTimersByTime(1000);
}

describe('ServerStallWatch', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
  });
  afterEach(() => jest.useRealTimers());

  it('writes one server-blocked row naming the last entered callback when the worker kept ticking', async () => {
    const { watch, ticks, rows } = setup();
    markEntered('reconciler pass');
    await watch.start(ticks);
    ticks.count += 12;
    tickAfter(12_000);
    tickAfter(0);
    await watch.onModuleDestroy();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'server-blocked',
      durationMs: 13_000,
      entered: 'reconciler pass',
      vmCpus: 6,
      vmMemoryBytes: 8_000_000_000,
    });
  });

  it('writes one host-paused row with no entered callback when the worker did not tick', async () => {
    const { watch, ticks, rows } = setup();
    markEntered('reconciler pass');
    await watch.start(ticks);
    tickAfter(12_000);
    await watch.onModuleDestroy();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'host-paused', entered: null, startedAt: '2026-01-01T00:00:00.000Z' });
  });

  it('gives one row for a stall with three agents running, carrying the load and the machine', async () => {
    const { watch, ticks, work, rows } = setup();
    work.start('a1', 'agent');
    work.start('a2', 'agent');
    work.start('a3', 'agent');
    work.start('c1', 'check');
    work.sample('a1', { cpuPercent: 100, rssBytes: 1000 });
    work.sample('a2', { cpuPercent: 50, rssBytes: 2000 });
    work.sample('a3', { cpuPercent: 25, rssBytes: 4000 });
    await watch.start(ticks);
    tickAfter(15_000);
    await watch.onModuleDestroy();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      runningAgents: 3,
      runningChecks: 1,
      runningSetups: 0,
      cpuPercent: 175,
      memoryBytes: 7000,
      vmCpus: 6,
      vmMemoryBytes: 8_000_000_000,
    });
  });

  it('keeps the machine empty when it is not known', async () => {
    const { watch, ticks, rows } = setup(null);
    await watch.start(ticks);
    tickAfter(12_000);
    await watch.onModuleDestroy();
    expect(rows[0]).toMatchObject({ vmCpus: null, vmMemoryBytes: null });
  });

  it('writes nothing for a gap of 9 s', async () => {
    const { watch, ticks, rows } = setup();
    await watch.start(ticks);
    tickAfter(9_000);
    await watch.onModuleDestroy();
    expect(rows).toEqual([]);
  });

  it('writes a later stall after a write failed', async () => {
    const { watch, ticks, rows } = setup(MACHINE, true);
    await watch.start(ticks);
    tickAfter(12_000);
    tickAfter(12_000);
    await watch.onModuleDestroy();
    expect(rows).toHaveLength(1);
  });

  it('closes the ticks and stops its timer on destroy', async () => {
    const { watch, ticks, rows } = setup();
    await watch.start(ticks);
    await watch.onModuleDestroy();
    tickAfter(12_000);
    expect(ticks.closed).toBe(true);
    expect(rows).toEqual([]);
  });
});
