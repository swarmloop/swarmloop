import { AppConfig } from '../../config/env';
import { testEnv } from '../../config/env.spec-helpers';
import type { StateReason } from '../../contract/run-state';
import { ContainerGate } from '../../sandbox/container-gate';
import type { AgentHold } from '../../sandbox/container-gate';
import { StartWaits } from './start-waits';

const PLACE = 'Waiting for a free agent place (1 of 1 busy)';

function setup() {
  const gate = new ContainerGate(new AppConfig(testEnv({ AGENTS_PARALLEL: 1 })));
  const waits = new StartWaits(gate, undefined as never);
  waits.onModuleInit();
  const written: (StateReason | null)[] = [];
  const store = (wait: StateReason | null): Promise<void> => {
    written.push(wait);
    return Promise.resolve();
  };
  const hold: AgentHold = { step: 'implement', onWait: () => undefined };
  const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
  return { gate, waits, written, store, hold, flush };
}

describe('StartWaits', () => {
  it('stores the place words with the busy count of a key in the line, and null once it got its place', async () => {
    const { gate, waits, written, store, hold, flush } = setup();
    const release = await gate.admit(jest.fn(), 'one', hold);
    void gate.admit(jest.fn(), 'two', hold);
    await flush();
    waits.register('two', store);
    await waits.changed('two');
    expect(written).toEqual([{ code: 'AGENT_PLACE', message: PLACE }]);
    release();
    await waits.changed('two');
    await waits.changed('two');
    expect(written).toEqual([{ code: 'AGENT_PLACE', message: PLACE }, null]);
  });

  it('rewrites a stored wait to the pause words and back to the place words', async () => {
    const { gate, waits, written, store, hold, flush } = setup();
    await gate.admit(jest.fn(), 'one', hold);
    void gate.admit(jest.fn(), 'two', hold);
    await flush();
    waits.register('two', store);
    await waits.changed('two');
    gate.pause();
    await waits.settled();
    gate.resume();
    await waits.settled();
    expect(written.map((wait) => wait?.code)).toEqual(['AGENT_PLACE', 'SERVER_PAUSE', 'AGENT_PLACE']);
  });

  it('stores nothing for a key that never waited', async () => {
    const { gate, waits, written, store, hold } = setup();
    await gate.admit(jest.fn(), 'one', hold);
    waits.register('one', store);
    await waits.changed('one');
    gate.pause();
    await waits.settled();
    expect(written).toEqual([]);
  });

  it('stores the latest state of the gate when changes are queued back to back', async () => {
    const { gate, waits, written, store, hold, flush } = setup();
    const release = await gate.admit(jest.fn(), 'one', hold);
    void gate.admit(jest.fn(), 'two', hold);
    await flush();
    waits.register('two', store);
    await waits.changed('two');
    const first = waits.changed('two');
    release();
    const second = waits.changed('two');
    await Promise.all([first, second]);
    expect(written).toEqual([{ code: 'AGENT_PLACE', message: PLACE }, null]);
  });

  it('logs a failed write and goes on with the next', async () => {
    const { gate, waits, hold, flush } = setup();
    await gate.admit(jest.fn(), 'one', hold);
    void gate.admit(jest.fn(), 'two', hold);
    await flush();
    const written: (StateReason | null)[] = [];
    let fail = true;
    waits.register('two', (wait) => {
      if (fail) {
        fail = false;
        return Promise.reject(new Error('disk'));
      }
      written.push(wait);
      return Promise.resolve();
    });
    await waits.changed('two');
    await waits.changed('two');
    expect(written).toHaveLength(1);
  });

  it('keeps a turn store through a gate rewrite that comes while its first write is queued', async () => {
    const { gate, waits, written, store, hold, flush } = setup();
    const release = await gate.admit(jest.fn(), 'one', hold);
    void gate.admit(jest.fn(), 'two', hold);
    await flush();
    waits.register('two', store);
    void waits.changed('two');
    gate.pause();
    await waits.settled();
    gate.resume();
    await waits.settled();
    release();
    await waits.changed('two');
    expect(written.map((wait) => wait?.code ?? null)).toEqual(['SERVER_PAUSE', 'SERVER_PAUSE', 'AGENT_PLACE', null]);
  });

  it('keeps a registered store through a rewrite while its start has not waited yet', async () => {
    const { gate, waits, written, store, hold, flush } = setup();
    await gate.admit(jest.fn(), 'one', hold);
    waits.register('two', store);
    gate.pause();
    await waits.settled();
    gate.resume();
    await waits.settled();
    expect(written).toEqual([]);
    void gate.admit(jest.fn(), 'two', hold);
    await flush();
    await waits.changed('two');
    expect(written).toEqual([{ code: 'AGENT_PLACE', message: PLACE }]);
  });

  it('writes a start with no store through the run path and drops the entry when the start ends', async () => {
    const { gate, hold, flush } = setup();
    const stored: (string | null)[] = [];
    const runs = {
      findRun: (key: string) => Promise.resolve({ key, status: 'running' }),
      recordStartWait: (_run: unknown, columns: { stateReason: string | null }) =>
        Promise.resolve(void stored.push(columns.stateReason)),
    };
    const waits = new StartWaits(gate, runs as never);
    const release = await gate.admit(jest.fn(), 'one', hold);
    void gate.admit(jest.fn(), 'two', hold);
    await flush();
    waits.register('two');
    await waits.changed('two');
    release();
    await waits.changed('two');
    await waits.changed('two');
    expect(stored.map((reason) => (reason ? (JSON.parse(reason) as { code: string }).code : null))).toEqual([
      'AGENT_PLACE',
      null,
    ]);
  });

  it('stores the wait of a run when its running agent ends while another of its agents waits behind another run', async () => {
    const gate = new ContainerGate(new AppConfig(testEnv({ AGENTS_PARALLEL: 2 })));
    const stored: string[] = [];
    const runs = {
      findRun: (key: string) => Promise.resolve({ key, status: 'running', state: 'running', stateReason: null }),
      recordStartWait: (_run: unknown, columns: { stateReason: string | null }) =>
        Promise.resolve(void stored.push(columns.stateReason ?? 'none')),
    };
    const waits = new StartWaits(gate, runs as never);
    waits.onModuleInit();
    const hold: AgentHold = { step: 'implement', onWait: () => undefined };
    const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
    const first = await gate.admit(jest.fn(), 'two', hold);
    await gate.admit(jest.fn(), 'x', hold);
    void gate.admit(jest.fn(), 'y', hold);
    void gate.admit(jest.fn(), 'two', hold);
    await flush();
    await waits.changed('two');
    expect(stored).toEqual([]);
    first();
    await waits.settled();
    expect(stored.map((reason) => (JSON.parse(reason) as { code: string }).code)).toEqual(['AGENT_PLACE']);
  });
});
