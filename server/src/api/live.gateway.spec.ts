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

const auth = {} as AuthService;

/** The run list as the kept rows give it: only the keys and the parent links matter to a publish. */
function rowsOf(runs: Array<{ key: string; parentKey?: string }>, recomputed = 1) {
  return { read: jest.fn().mockResolvedValue({ view: { runs }, recomputed }) };
}

/** A server with `connected` sockets, and the rooms with a socket in them. */
function serverOf(connected: number, watchedRooms: string[], sent: Array<{ room: string; entry: unknown }> = []) {
  return {
    emit: jest.fn(),
    sockets: {
      sockets: new Map(Array.from({ length: connected }, (_, n) => [`socket-${n}`, {}])),
      adapter: { rooms: new Map(watchedRooms.map((name) => [name, new Set(['socket'])])) },
    },
    to: (room: string) => ({ emit: (_name: string, entry: unknown) => sent.push({ room, entry }) }),
  } as unknown as LiveGateway['server'];
}

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
      );
      gateway.server = serverOf(1, []);
      gateway.onModuleInit();
      hub.changed('run-1');
      await jest.advanceTimersByTimeAsync(60);
      gateway.onModuleDestroy();
      expect(error).toHaveBeenCalledWith('boom');
    } finally {
      jest.useRealTimers();
      error.mockRestore();
    }
  });

  describe('a change to a subtask', () => {
    async function publish(watchedRooms: string[]) {
      jest.useFakeTimers();
      try {
        const hub = new LiveHub();
        const flows: Record<string, { key: string; parentKey?: string }> = {
          'run-1-a': { key: 'run-1-a', parentKey: 'run-1' },
          'run-1': { key: 'run-1' },
        };
        const runs = { list: jest.fn(), flow: jest.fn(async (key: string) => flows[key]) };
        const rows = rowsOf([{ key: 'run-1-a', parentKey: 'run-1' }, { key: 'run-1' }]);
        const gateway = new LiveGateway(
          hub,
          runs as unknown as RunQueriesService,
          auth,
          new ContainerGate(),
          rows as unknown as RunListRows,
          new FakeClock(),
        );
        const sent: Array<{ room: string; entry: unknown }> = [];
        gateway.server = serverOf(1, watchedRooms, sent);
        gateway.onModuleInit();
        hub.changed('run-1-a');
        await jest.advanceTimersByTimeAsync(60);
        gateway.onModuleDestroy();
        return { sent, flows };
      } finally {
        jest.useRealTimers();
      }
    }

    it('also publishes the flow of its parent run when someone watches the parent', async () => {
      const { sent, flows } = await publish(['run:run-1']);
      expect(sent).toEqual([{ room: 'run:run-1', entry: flows['run-1'] }]);
    });

    it('builds no parent flow when nobody watches the parent', async () => {
      const { sent } = await publish([]);
      expect(sent).toEqual([]);
    });
  });

  describe('what a publish costs', () => {
    async function publishOf(options: {
      connected: number;
      watched: string[];
      read?: (clock: FakeClock) => void;
      flow?: (clock: FakeClock) => void;
      parentKey?: string;
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
        };
        const rows = rowsOf([{ key: 'run-1' }], 3);
        rows.read.mockImplementation(async () => {
          options.read?.(clock);
          return { view: { runs: [{ key: 'run-1', parentKey: options.parentKey }] }, recomputed: 3 };
        });
        const gateway = new LiveGateway(
          hub,
          runs as unknown as RunQueriesService,
          auth,
          new ContainerGate(),
          rows as unknown as RunListRows,
          clock,
        );
        const sent: Array<{ room: string; entry: unknown }> = [];
        const server = serverOf(options.connected, options.watched, sent);
        gateway.server = server;
        gateway.onModuleInit();
        hub.changed('run-1');
        await jest.advanceTimersByTimeAsync(60);
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
      expect(unwatched.emit).toHaveBeenCalledWith('runs', { runs: [{ key: 'run-1' }] });
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
      const { sent } = await publishOf({ connected: 1, watched: ['run:epic'], parentKey: 'epic' });
      expect(sent).toEqual([{ room: 'run:epic', entry: { key: 'epic' } }]);
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
      );
      const joined: string[] = [];
      const told: Array<[string, unknown]> = [];
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

  describe('server pause', () => {
    function gatewayOn(gate: ContainerGate) {
      const gateway = new LiveGateway(
        new LiveHub(),
        { list: jest.fn().mockResolvedValue({ runs: [] }) } as unknown as RunQueriesService,
        auth,
        gate,
        {} as RunListRows,
        new FakeClock(),
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
      );
      gateway.server = serverOf(1, []);
      gateway.onModuleInit();
      hub.changed('run-1');
      gateway.onModuleDestroy();
      await jest.advanceTimersByTimeAsync(60);
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
