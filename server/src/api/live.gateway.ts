import { Logger, NotFoundException, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { OnGatewayConnection, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { FlowView } from '../contract/api';
import { ClientToServerEvents, LiveEvents, ServerToClientEvents } from '../contract/live';
import { RunQueriesService } from '../api/run-queries.service';
import { LiveHub } from '../live/live.hub';
import { PANEL_ORIGINS } from '../live/origins';

@WebSocketGateway({ cors: { origin: PANEL_ORIGINS }, transports: ['websocket'] })
export class LiveGateway implements OnModuleInit, OnModuleDestroy, OnGatewayConnection {
  @WebSocketServer()
  server!: Server<ClientToServerEvents, ServerToClientEvents>;

  private readonly logger = new Logger(LiveGateway.name);
  private readonly stop: Array<() => void> = [];
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly eventWindows = new Map<string, { timer: ReturnType<typeof setTimeout>; latest: LiveEvents }>();

  constructor(
    private readonly hub: LiveHub,
    private readonly runs: RunQueriesService,
  ) {}

  onModuleInit(): void {
    this.stop.push(this.hub.onChanged((key) => this.queue(key)));
    this.stop.push(this.hub.onSpend((key) => this.queue(key)));
    this.stop.push(
      this.hub.onLog((entry) => {
        this.server.to(room(entry.key)).emit('log', entry);
      }),
    );
    this.stop.push(this.hub.onEvents((entry) => this.throttle(entry)));
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

  private async publish(key: string): Promise<void> {
    try {
      const [list, flow] = await Promise.all([this.runs.list(), this.flowOf(key)]);
      this.server.emit('runs', list);
      if (flow) {
        this.server.to(room(key)).emit('flow', flow);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'live update failed';
      this.logger.error(message);
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
