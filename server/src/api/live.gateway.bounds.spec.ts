import 'reflect-metadata';
import type { AuthService } from '../auth/auth.service';
import type { LiveRunUsage } from '../contract/live';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { LiveHub } from '../live/live.hub';
import { ContainerGate } from '../sandbox/container-gate';
import { LiveGateway } from './live.gateway';
import { rowsOf, serverOf, usageOf } from './live.gateway.spec-helpers';
import type { RunListRows } from './run-list-rows';
import type { RunQueriesService } from './run-queries.service';

/** What a gateway builds and sends for a scenario: the flows it built, and what each room and every socket got. */
async function scenario(act: (hub: LiveHub) => void, options: { entries?: LiveRunUsage[]; watched?: string[] } = {}) {
  jest.useFakeTimers();
  try {
    const hub = new LiveHub();
    const built: string[] = [];
    const runs = {
      flow: async (key: string) => {
        built.push(key);
        return { key };
      },
    };
    const gateway = new LiveGateway(
      hub,
      runs as unknown as RunQueriesService,
      {} as AuthService,
      new ContainerGate(),
      rowsOf([{ key: 'run-1' }]) as unknown as RunListRows,
      new FakeClock(),
      usageOf(options.entries ?? []),
    );
    const toRooms: Array<{ room: string; entry: unknown }> = [];
    const server = serverOf(1, options.watched ?? ['run:run-1'], toRooms);
    gateway.server = server;
    gateway.onModuleInit();
    act(hub);
    await jest.advanceTimersByTimeAsync(100);
    gateway.onModuleDestroy();
    const emitted = (server as unknown as { emit: jest.Mock }).emit.mock.calls as Array<[string, unknown]>;
    return { built, toRooms, emitted };
  } finally {
    jest.useRealTimers();
  }
}

const entry: LiveRunUsage = { key: 'run-1', tokens: 30, usd: 0.5, cpuPeak: 10, memPeak: 20 };

describe('what the gateway builds and sends for one change', () => {
  it('builds no flow for a log line', async () => {
    const { built, toRooms, emitted } = await scenario((hub) =>
      hub.log({ key: 'run-1', step: 'implement', body: 'hello' }),
    );
    expect(built).toEqual([]);
    expect(emitted).toEqual([]);
    expect(toRooms).toEqual([{ room: 'run:run-1', entry: { key: 'run-1', step: 'implement', body: 'hello' } }]);
  });

  it('sends one usage event and builds no flow for a usage change of a run without a parent', async () => {
    const { built, emitted } = await scenario(
      (hub) => hub.log({ key: 'run-1', step: 'implement', body: '', usage: { tokensIn: 10, tokensOut: 20, usd: 0.5 } }),
      { entries: [entry] },
    );
    expect(built).toEqual([]);
    expect(emitted).toEqual([['usage', entry]]);
  });

  it('sends the usage events of a batch once each', async () => {
    const { built, emitted } = await scenario(
      (hub) => {
        hub.log({ key: 'run-1', step: 'implement', body: '', usage: { tokensIn: 1, tokensOut: 0, usd: 0.1 } });
        hub.log({ key: 'run-1', step: 'implement', body: '', usage: { tokensIn: 2, tokensOut: 0, usd: 0.2 } });
      },
      { entries: [entry] },
    );
    expect(built).toEqual([]);
    expect(emitted).toEqual([['usage', entry]]);
  });

  it('gives a key that changed and spent both its flow and its usage', async () => {
    const { built, emitted } = await scenario(
      (hub) => {
        hub.changed('run-1');
        hub.log({ key: 'run-1', step: 'implement', body: '', usage: { tokensIn: 10, tokensOut: 20, usd: 0.5 } });
      },
      { entries: [entry] },
    );
    expect(built).toEqual(['run-1']);
    expect(emitted).toContainEqual(['usage', entry]);
  });
});
