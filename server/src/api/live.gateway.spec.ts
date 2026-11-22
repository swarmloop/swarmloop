import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import type { RunQueriesService } from '../api/run-queries.service';
import type { RunListRows } from './run-list-rows';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { enteredBefore } from '../core/entered-marks';
import { allowHandshake, LiveGateway } from './live.gateway';
import type { AuthService } from '../auth/auth.service';
import { LiveHub } from '../live/live.hub';
import { ContainerGate } from '../sandbox/container-gate';
import { clientOf, noUsage, rowsOf, runsOf, serverOf, summaryOf, usageOf } from './live.gateway.spec-helpers';

const auth = {} as AuthService;

describe('LiveGateway', () => {
  it('logs a live update that fails', async () => {
    jest.useFakeTimers();
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      const hub = new LiveHub();
      const runs = { list: jest.fn(), flow: jest.fn() };
      const rows = { read: jest.fn().mockRejectedValue(new Error('boom')) };
      const gateway = new LiveGateway(
        hub,
        runs as unknown as RunQueriesService,
        auth,
        new ContainerGate(),
        rows as unknown as RunListRows,
        new FakeClock(),
        noUsage(),
      );
      gateway.server = serverOf(1, []);
      gateway.onModuleInit();
      hub.changed('run-1');
      await jest.advanceTimersByTimeAsync(100);
      gateway.onModuleDestroy();
      expect(error).toHaveBeenCalledWith('boom');
    } finally {
      jest.useRealTimers();
      error.mockRestore();
    }
  });

  describe('a live log line', () => {
    function logTo(watched: string[]) {
      const hub = new LiveHub();
      const gateway = new LiveGateway(
        hub,
        {} as unknown as RunQueriesService,
        auth,
        new ContainerGate(),
        {} as unknown as RunListRows,
        new FakeClock(),
        noUsage(),
      );
      const sent: Array<{ room: string; entry: unknown }> = [];
      gateway.server = serverOf(1, watched, sent);
      gateway.onModuleInit();
      const entry = { key: 'run-1', step: 'plan', line: 'hello' };
      hub.log(entry as unknown as Parameters<LiveHub['log']>[0]);
      gateway.onModuleDestroy();
      return { sent, entry };
    }

    it('is encoded for nobody when no socket watches the run', () => {
      expect(logTo([]).sent).toEqual([]);
    });

    it('arrives in the room of the run when a socket watches it', () => {
      const { sent, entry } = logTo(['run:run-1']);
      expect(sent).toEqual([{ room: 'run:run-1', entry }]);
    });
  });

  describe('a change to a subtask', () => {
    const figures = { tokens: 7, usd: 0.7, cpuPeak: 1, memPeak: 2 };
    async function publish(watchedRooms: string[]) {
      jest.useFakeTimers();
      try {
        const hub = new LiveHub();
        const { service, built, tasked } = runsOf(
          { 'run-1': { key: 'run-1', metrics: { tokens: 0, usd: 0, cpuPeak: 0, memPeak: 0, status: 'running' } } },
          { 'run-1': { tasks: [{ key: 'run-1-a' }] } },
        );
        const rows = rowsOf([{ key: 'run-1-a', parentKey: 'run-1' }, { key: 'run-1' }]);
        const gateway = new LiveGateway(
          hub,
          service,
          auth,
          new ContainerGate(),
          rows as unknown as RunListRows,
          new FakeClock(),
          usageOf([
            { key: 'run-1-a', ...figures },
            { key: 'run-1', ...figures },
          ]),
        );
        const sent: Array<{ room: string; entry: unknown }> = [];
        gateway.server = serverOf(1, watchedRooms, sent);
        gateway.onModuleInit();
        if (watchedRooms.length > 0) {
          await gateway.watch(clientOf(), 'run-1');
          sent.length = 0;
          built.length = 0;
        }
        hub.changed('run-1-a');
        await jest.advanceTimersByTimeAsync(100);
        gateway.onModuleDestroy();
        return { sent, built, tasked };
      } finally {
        jest.useRealTimers();
      }
    }

    it('also publishes the flow of its parent run when someone watches the parent', async () => {
      const { sent, built, tasked } = await publish(['run:run-1']);
      expect(built).toEqual([]);
      expect(tasked).toEqual(['run-1']);
      expect(sent).toEqual([
        {
          room: 'run:run-1',
          entry: {
            key: 'run-1',
            metrics: { ...figures, status: 'running' },
            tasks: [{ key: 'run-1-a' }],
          },
        },
      ]);
    });

    it('builds no parent flow when nobody watches the parent', async () => {
      const { sent, tasked } = await publish([]);
      expect(sent).toEqual([]);
      expect(tasked).toEqual([]);
    });
  });

  describe('what a publish costs', () => {
    async function publishOf(options: {
      connected: number;
      watched: string[];
      read?: (clock: FakeClock) => void;
      flow?: (clock: FakeClock) => void;
      parentKey?: string;
      seeded?: boolean;
    }) {
      jest.useFakeTimers();
      try {
        const clock = new FakeClock();
        const hub = new LiveHub();
        const runs = {
          list: jest.fn(),
          flow: jest.fn(async (key: string) => {
            options.flow?.(clock);
            return { key };
          }),
          tasks: jest.fn(async () => ({ taskLine: 'line' })),
        };
        const rows = rowsOf([{ key: 'run-1' }], 3);
        rows.read.mockImplementation(async () => {
          options.read?.(clock);
          return { view: { runs: [summaryOf({ key: 'run-1', parentKey: options.parentKey })] }, recomputed: 3 };
        });
        const gateway = new LiveGateway(
          hub,
          runs as unknown as RunQueriesService,
          auth,
          new ContainerGate(),
          rows as unknown as RunListRows,
          clock,
          usageOf([{ key: 'epic', tokens: 1, usd: 2, cpuPeak: 3, memPeak: 4 }]),
        );
        const sent: Array<{ room: string; entry: unknown }> = [];
        const server = serverOf(options.connected, options.watched, sent);
        gateway.server = server;
        gateway.onModuleInit();
        if (options.seeded) {
          await gateway.watch(clientOf(), 'epic');
          sent.length = 0;
        }
        hub.changed('run-1');
        await jest.advanceTimersByTimeAsync(100);
        gateway.onModuleDestroy();
        return { rows, sent, emit: (server as unknown as { emit: jest.Mock }).emit };
      } finally {
        jest.useRealTimers();
      }
    }

    it('computes and emits nothing for the run list with no socket connected', async () => {
      const { rows, sent, emit } = await publishOf({ connected: 0, watched: ['run:run-1'] });
      expect(rows.read).not.toHaveBeenCalled();
      expect(emit).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    });

    it('names the live update as the callback it is blocked in', async () => {
      let entered: string | null = null;
      await publishOf({
        connected: 1,
        watched: [],
        read: () => {
          entered = enteredBefore(Date.now());
        },
      });
      expect(entered).toBe('live update run-1');
    });

    it('sends a flow only to a watched room', async () => {
      const unwatched = await publishOf({ connected: 1, watched: ['run:other'] });
      expect(unwatched.emit).toHaveBeenCalledWith('run', {
        rows: [summaryOf({ key: 'run-1' })],
        removed: [],
        counts: { active: 1, done: 0, all: 1 },
      });
      expect(unwatched.sent).toEqual([]);
      const watched = await publishOf({ connected: 1, watched: ['run:run-1'] });
      expect(watched.sent).toEqual([{ room: 'run:run-1', entry: { key: 'run-1' } }]);
    });

    it('logs a publish over one second with its duration and recomputed rows', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        await publishOf({ connected: 1, watched: [], read: (clock) => clock.advance(1000) });
        expect(warn).not.toHaveBeenCalled();
        await publishOf({ connected: 1, watched: [], read: (clock) => clock.advance(1500) });
        expect(warn).toHaveBeenCalledWith('live update of run-1 took 1500 ms, recomputed 3 rows and built 0 flows');
      } finally {
        warn.mockRestore();
      }
    });

    it('logs a publish whose flow build takes over one second', async () => {
      const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
      try {
        await publishOf({ connected: 1, watched: ['run:run-1'], flow: (clock) => clock.advance(1500) });
        expect(warn).toHaveBeenCalledWith('live update of run-1 took 1500 ms, recomputed 3 rows and built 1 flows');
      } finally {
        warn.mockRestore();
      }
    });

    it('builds only the parent flow when only the parent room is watched', async () => {
      const { sent } = await publishOf({ connected: 1, watched: ['run:epic'], parentKey: 'epic', seeded: true });
      expect(sent).toEqual([
        {
          room: 'run:epic',
          entry: { key: 'epic', taskLine: 'line', metrics: { tokens: 1, usd: 2, cpuPeak: 3, memPeak: 4 } },
        },
      ]);
    });
  });

  describe('watch', () => {
    it('sends the flow of a run to the socket that watches it', async () => {
      const gateway = new LiveGateway(
        new LiveHub(),
        { flow: jest.fn(async (key: string) => ({ key })) } as unknown as RunQueriesService,
        auth,
        new ContainerGate(),
        {} as RunListRows,
        new FakeClock(),
        noUsage(),
      );
      const joined: string[] = [];
      const told: Array<[string, unknown]> = [];
      // The joining socket is in the room, so a page sent to the room reaches it.
      gateway.server = {
        to: () => ({ emit: (name: string, entry: unknown) => told.push([name, entry]) }),
      } as unknown as LiveGateway['server'];
      const client = {
        rooms: new Set<string>(),
        join: async (name: string) => joined.push(name),
        emit: (name: string, entry: unknown) => told.push([name, entry]),
      };
      await gateway.watch(client as never, 'run-1');
      expect(joined).toEqual(['run:run-1']);
      expect(told).toEqual([['flow', { key: 'run-1' }]]);
    });
  });

  it('sends a backlog entry to every socket, and stops after destroy', () => {
    const hub = new LiveHub();
    const gateway = new LiveGateway(
      hub,
      {} as unknown as RunQueriesService,
      auth,
      new ContainerGate(),
      {} as RunListRows,
      new FakeClock(),
      noUsage(),
    );
    const sent: unknown[] = [];
    gateway.server = {
      emit: (name: string, entry: unknown) => sent.push([name, entry]),
    } as unknown as LiveGateway['server'];
    gateway.onModuleInit();
    const entry = { backlog: 'shop', turn: { status: 'running' as const, reason: '', nextTryAt: null } };
    hub.backlog(entry);
    gateway.onModuleDestroy();
    hub.backlog(entry);
    expect(sent).toEqual([['backlog', entry]]);
  });

  describe('server pause', () => {
    function gatewayOn(gate: ContainerGate) {
      const gateway = new LiveGateway(
        new LiveHub(),
        { list: jest.fn().mockResolvedValue({ runs: [] }) } as unknown as RunQueriesService,
        auth,
        gate,
        rowsOf([]) as unknown as RunListRows,
        new FakeClock(),
        noUsage(),
      );
      const sent: unknown[] = [];
      gateway.server = {
        emit: (name: string, state: unknown) => sent.push([name, state]),
      } as unknown as LiveGateway['server'];
      return { gateway, sent };
    }

    it('tells a connecting client whether the server is paused', async () => {
      const gate = new ContainerGate();
      const { gateway } = gatewayOn(gate);
      const told: unknown[] = [];
      const client = { emit: (name: string, state: unknown) => told.push([name, state]) };
      await gateway.handleConnection(client as never);
      gate.pause();
      await gateway.handleConnection(client as never);
      expect(told.filter((entry) => (entry as string[])[0] === 'server')).toEqual([
        ['server', { paused: false }],
        ['server', { paused: true }],
      ]);
    });

    it('tells every client when the pause changes, and stops after destroy', () => {
      const gate = new ContainerGate();
      const { gateway, sent } = gatewayOn(gate);
      gateway.onModuleInit();
      gate.pause();
      gate.resume();
      gateway.onModuleDestroy();
      gate.pause();
      expect(sent).toEqual([
        ['server', { paused: true }],
        ['server', { paused: false }],
      ]);
    });
  });

  describe('the run list', () => {
    function gatewayWith(runsList: Array<{ key: string; parentKey?: string; state?: string }>, connected: number) {
      const hub = new LiveHub();
      const rows = rowsOf(runsList);
      const gateway = new LiveGateway(
        hub,
        { flow: jest.fn() } as unknown as RunQueriesService,
        auth,
        new ContainerGate(),
        rows as unknown as RunListRows,
        new FakeClock(),
        noUsage(),
      );
      const server = serverOf(connected, []);
      gateway.server = server;
      gateway.onModuleInit();
      return { hub, gateway, emit: (server as unknown as { emit: jest.Mock }).emit };
    }

    it('a connecting socket gets the active runs and the counts once', async () => {
      const { gateway } = gatewayWith(
        [{ key: 'run-1' }, { key: 'run-2', state: 'done' }, { key: 'run-3', parentKey: 'run-1' }],
        1,
      );
      const told: Array<[string, unknown]> = [];
      await gateway.handleConnection({ emit: (name: string, entry: unknown) => told.push([name, entry]) } as never);
      gateway.onModuleDestroy();
      const runs = told.filter(([name]) => name === 'runs');
      expect(runs).toHaveLength(1);
      expect(runs[0][1]).toEqual({
        runs: [summaryOf({ key: 'run-1' }), summaryOf({ key: 'run-3', parentKey: 'run-1' })],
        counts: { active: 1, done: 1, all: 2 },
        otherMatches: 1,
        next: null,
      });
    });

    it('twenty changed and spend events for five runs within 100 ms give one run event with those five rows and no runs', async () => {
      jest.useFakeTimers();
      try {
        const keys = ['run-1', 'run-2', 'run-3', 'run-4', 'run-5'];
        const { hub, gateway, emit } = gatewayWith(
          [...keys, 'run-6'].map((key) => ({ key })),
          1,
        );
        await gateway.handleConnection({ emit: () => undefined } as never);
        // The connect read is the baseline; a later read that differs only in these five rows.
        for (let n = 0; n < 10; n += 1) {
          hub.changed(keys[n % 5]);
          hub.log({ key: keys[n % 5], step: 'implement', body: '', usage: { tokensIn: n + 1, tokensOut: 0, usd: 0 } });
        }
        await jest.advanceTimersByTimeAsync(100);
        gateway.onModuleDestroy();
        const runEvents = emit.mock.calls.filter(([name]) => name === 'run');
        expect(runEvents).toHaveLength(1);
        expect(runEvents[0][1].rows.map((row: { key: string }) => row.key)).toEqual(keys);
        expect(runEvents[0][1].removed).toEqual([]);
        expect(emit.mock.calls.some(([name]) => name === 'runs')).toBe(false);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  it('drops a pending update when it is destroyed', async () => {
    jest.useFakeTimers();
    try {
      const hub = new LiveHub();
      const rows = rowsOf([]);
      const gateway = new LiveGateway(
        hub,
        { flow: jest.fn() } as unknown as RunQueriesService,
        auth,
        new ContainerGate(),
        rows as unknown as RunListRows,
        new FakeClock(),
        noUsage(),
      );
      gateway.server = serverOf(1, []);
      gateway.onModuleInit();
      hub.changed('run-1');
      gateway.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(100);
      expect(rows.read).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  describe('events', () => {
    function setup() {
      const hub = new LiveHub();
      const gateway = new LiveGateway(
        hub,
        { list: jest.fn(), flow: jest.fn() } as unknown as RunQueriesService,
        auth,
        new ContainerGate(),
        {} as RunListRows,
        new FakeClock(),
        noUsage(),
      );
      const sent: Array<{ room: string; entry: unknown }> = [];
      gateway.server = {
        to: (room: string) => ({ emit: (_name: string, entry: unknown) => sent.push({ room, entry }) }),
      } as unknown as LiveGateway['server'];
      gateway.onModuleInit();
      return { hub, gateway, sent };
    }

    it('sends one message per 500 ms window with the last seq, then another for a later window', () => {
      jest.useFakeTimers();
      try {
        const { hub, gateway, sent } = setup();
        hub.appended({ key: 'run-1', step: 'implement', seq: 1 });
        jest.advanceTimersByTime(200);
        hub.appended({ key: 'run-1', step: 'implement', seq: 5 });
        expect(sent).toEqual([]);
        jest.advanceTimersByTime(300);
        expect(sent).toEqual([{ room: 'run:run-1', entry: { key: 'run-1', step: 'implement', seq: 5 } }]);
        hub.appended({ key: 'run-1', step: 'implement', seq: 6 });
        jest.advanceTimersByTime(500);
        expect(sent).toHaveLength(2);
        expect(sent[1].entry).toEqual({ key: 'run-1', step: 'implement', seq: 6 });
        gateway.onModuleDestroy();
      } finally {
        jest.useRealTimers();
      }
    });

    it('keeps two runs apart', () => {
      jest.useFakeTimers();
      try {
        const { hub, gateway, sent } = setup();
        hub.appended({ key: 'run-a', step: 'implement', seq: 3 });
        hub.appended({ key: 'run-b', step: 'commit', seq: 9 });
        jest.advanceTimersByTime(500);
        expect(sent).toEqual([
          { room: 'run:run-a', entry: { key: 'run-a', step: 'implement', seq: 3 } },
          { room: 'run:run-b', entry: { key: 'run-b', step: 'commit', seq: 9 } },
        ]);
        gateway.onModuleDestroy();
      } finally {
        jest.useRealTimers();
      }
    });
  });

  describe('handshake host', () => {
    const decide = (host: string | undefined) => {
      let allowed: boolean | undefined;
      allowHandshake({ headers: { host } }, (_error, ok) => (allowed = ok));
      return allowed;
    };

    it('refuses a foreign Origin and accepts a panel Origin or none', () => {
      const decideOrigin = (origin: string | undefined) => {
        let allowed: boolean | undefined;
        allowHandshake({ headers: { host: '127.0.0.1:3920', origin } }, (_error, ok) => (allowed = ok));
        return allowed;
      };
      expect(decideOrigin('https://evil.example')).toBe(false);
      expect(decideOrigin('http://localhost:3921')).toBe(true);
      expect(decideOrigin(undefined)).toBe(true);
    });

    it('refuses a foreign Host and accepts the own hosts', () => {
      expect(decide('evil.example:3920')).toBe(false);
      expect(decide(undefined)).toBe(false);
      expect(decide('127.0.0.1:3920')).toBe(true);
      expect(decide('localhost:3920')).toBe(true);
    });
  });

  describe('login', () => {
    function connect(check: AuthService['check'], headers: Record<string, string>) {
      const gateway = new LiveGateway(
        new LiveHub(),
        {} as RunQueriesService,
        { check } as unknown as AuthService,
        new ContainerGate(),
        {} as RunListRows,
        new FakeClock(),
        noUsage(),
      );
      let middleware!: (socket: unknown, next: (error?: Error) => void) => void;
      gateway.afterInit({ use: (fn: typeof middleware) => (middleware = fn) } as never);
      return new Promise<Error | undefined>((resolve) => middleware({ handshake: { headers } }, resolve));
    }

    it('refuses a socket without a session or token and takes one with', async () => {
      const check = jest.fn(async ({ cookie }: { cookie?: string }) => ({
        allowed: cookie === 'swarmloop_session=abc',
        actor: null,
        via: null,
      }));
      expect((await connect(check, {}))?.message).toBe('log in first');
      expect(await connect(check, { cookie: 'swarmloop_session=abc' })).toBeUndefined();
    });
  });
});
