import { Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { FlowView } from '../contract/api';
import { ClientToServerEvents, LiveEvents, ServerToClientEvents } from '../contract/live';
import { RunQueriesService } from '../api/run-queries.service';
import { RunListRows } from './run-list-rows';
import { Clock } from '../core/clock';
import { LiveHub } from '../live/live.hub';
import { readDefaultSettings } from '../config/load-env';
import { rawEnv } from '../config/process-env';
import { allowedOrigins, originAllowed } from '../live/origins';
import { AuthService } from '../auth/auth.service';
import { ContainerGate } from '../sandbox/container-gate';
import { isAllowedHost } from './allowed-hosts';

/** A publish that takes longer than this is logged. */
const SLOW_PUBLISH_MS = 1000;

const PUBLIC_URL = () => rawEnv().SWARMLOOP_PUBLIC_URL ?? readDefaultSettings().SWARMLOOP_PUBLIC_URL;

/** socket.io handshakes bypass Express middleware, so the Host and Origin rules are applied here. */
export function allowHandshake(
  request: { headers: { host?: string; origin?: string } },
  done: (error: string | null, ok: boolean) => void,
): void {
  const { host, origin } = request.headers;
  done(null, isAllowedHost(host, PUBLIC_URL()) && (origin === undefined || originAllowed(origin, PUBLIC_URL())));
}

@WebSocketGateway({
  cors: { origin: allowedOrigins(PUBLIC_URL()), credentials: true },
  transports: ['websocket'],
  allowRequest: allowHandshake,
})
export class LiveGateway implements OnModuleInit, OnModuleDestroy, OnGatewayConnection, OnGatewayInit {
  @WebSocketServer()
  server!: Server<ClientToServerEvents, ServerToClientEvents>;

  private readonly logger = new Logger(LiveGateway.name);
  private readonly stop: Array<() => void> = [];
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly eventWindows = new Map<string, { timer: ReturnType<typeof setTimeout>; latest: LiveEvents }>();

  constructor(
    private readonly hub: LiveHub,
    private readonly runs: RunQueriesService,
    private readonly auth: AuthService,
    private readonly gate: ContainerGate,
    private readonly rows: RunListRows,
    private readonly clock: Clock,
  ) {}

  /** A socket needs the session cookie or a personal token, like a request. */
  afterInit(server: Server): void {
    server.use((socket, next) => {
      const { cookie, authorization } = socket.handshake.headers;
      this.auth.check({ cookie, authorization }).then(
        ({ allowed }) => next(allowed ? undefined : new Error('log in first')),
        () => next(new Error('log in first')),
      );
    });
  }

  onModuleInit(): void {
    this.stop.push(this.hub.onChanged((key) => this.queue(key)));
    this.stop.push(this.hub.onSpend((key) => this.queue(key)));
    this.stop.push(
      this.hub.onLog((entry) => {
        this.server.to(room(entry.key)).emit('log', entry);
      }),
    );
    this.stop.push(this.hub.onEvents((entry) => this.throttle(entry)));
    this.stop.push(this.gate.onChange((paused) => this.server.emit('server', { paused })));
  }

  onModuleDestroy(): void {
    for (const stop of this.stop) {
      stop();
    }
    for (const timer of this.pending.values()) {
      clearTimeout(timer);
    }
    for (const { timer } of this.eventWindows.values()) {
      clearTimeout(timer);
    }
  }

  async handleConnection(client: Socket<ClientToServerEvents, ServerToClientEvents>): Promise<void> {
    client.emit('server', { paused: this.gate.paused() });
    client.emit('runs', await this.runs.list());
  }

  @SubscribeMessage('watch')
  async watch(client: Socket<ClientToServerEvents, ServerToClientEvents>, key: unknown): Promise<void> {
    if (typeof key !== 'string' || key === '') {
      return;
    }
    for (const name of client.rooms) {
      if (name.startsWith('run:')) {
        await client.leave(name);
      }
    }
    await client.join(room(key));
    const flow = await this.flowOf(key);
    if (flow) {
      client.emit('flow', flow);
    }
  }

  /** At most one `events` message per run in a 500 ms window; the window ends with the latest entry. */
  private throttle(entry: LiveEvents): void {
    const window = this.eventWindows.get(entry.key);
    if (window) {
      window.latest = entry;
      return;
    }
    const opened = {
      latest: entry,
      timer: setTimeout(() => {
        this.eventWindows.delete(entry.key);
        this.server.to(room(entry.key)).emit('events', opened.latest);
      }, 500),
    };
    this.eventWindows.set(entry.key, opened);
  }

  private queue(key: string): void {
    const existing = this.pending.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        void this.publish(key);
      }, 40),
    );
  }

  /** Sends the run list to every socket and the flow of a run, and of its parent, to the room that watches it. Nothing without a socket. */
  private async publish(key: string): Promise<void> {
    if (this.server.sockets.sockets.size === 0) {
      return;
    }
    const started = this.clock.now();
    try {
      const { view, recomputed } = await this.rows.read();
      let built = 0;
      this.server.emit('runs', view);
      // A subtask's step, cost and time show on its parent's page.
      const parentKey = view.runs.find((row) => row.key === key)?.parentKey;
      for (const watched of [key, parentKey]) {
        if (watched && this.server.sockets.adapter.rooms.has(room(watched))) {
          built += 1;
          await this.emitFlow(watched);
        }
      }
      const took = this.clock.now() - started;
      if (took > SLOW_PUBLISH_MS) {
        this.logger.warn(
          `live update of ${key} took ${took} ms, recomputed ${recomputed} rows and built ${built} flows`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'live update failed';
      this.logger.error(message);
    }
  }

  private async emitFlow(key: string): Promise<void> {
    const flow = await this.flowOf(key);
    if (flow) {
      this.server.to(room(key)).emit('flow', flow);
    }
  }

  private async flowOf(key: string): Promise<FlowView | null> {
    try {
      return await this.runs.flow(key);
    } catch (error) {
      if (error instanceof NotFoundException) {
        return null;
      }
      throw error;
    }
  }
}

function room(key: string): string {
  return `run:${key}`;
}
