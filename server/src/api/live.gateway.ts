import { Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  OnGatewayConnection,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { ClientToServerEvents, LiveEvents, LiveRunUsage, ServerToClientEvents } from '../contract/live';
import { RunQueriesService } from '../api/run-queries.service';
import { filterRuns } from '../contract/run-list';
import { LiveFlowRooms, room } from './live-flow-rooms';
import { DoneLatelyChanges } from './done-lately-changes';
import { DoneLatelyService } from './done-lately.service';
import { RunListChanges } from './run-list-changes';
import { pageOf } from './run-list-page';
import { RunListRows } from './run-list-rows';
import type { RunsView } from '../contract/api';
import { Clock } from '../core/clock';
import { markEntered } from '../core/entered-marks';
import { LiveHub } from '../live/live.hub';
import { readDefaultSettings } from '../config/load-env';
import { rawEnv } from '../config/process-env';
import { allowedOrigins, originAllowed } from '../live/origins';
import { AuthService } from '../auth/auth.service';
import { ContainerGate } from '../sandbox/container-gate';
import { isAllowedHost } from './allowed-hosts';
import { RunUsageReader } from './run-usage';

/** Changes within this window go out as one `run` event. */
const BATCH_MS = 100;

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
  private readonly changes = new RunListChanges();
  private readonly doneChanges = new DoneLatelyChanges();
  private readonly flows: LiveFlowRooms;
  private readonly batch = new Set<string>();
  /** Keys whose spend, tokens or peaks moved in this batch; they send a `usage` event, not a page. */
  private readonly spent = new Set<string>();
  /** A backlog change since the last batch: it can accept a milestone, so Done lately is worked out again. */
  private doneDue = false;
  private batchTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly eventWindows = new Map<string, { timer: ReturnType<typeof setTimeout>; latest: LiveEvents }>();

  constructor(
    private readonly hub: LiveHub,
    runs: RunQueriesService,
    private readonly auth: AuthService,
    private readonly gate: ContainerGate,
    private readonly rows: RunListRows,
    private readonly clock: Clock,
    private readonly usage: RunUsageReader,
    private readonly doneLately: DoneLatelyService,
  ) {
    this.flows = new LiveFlowRooms(runs, () => this.server);
  }

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
    this.stop.push(this.hub.onChanged((key) => this.queue(key, this.batch)));
    this.stop.push(this.hub.onSpend((key) => this.queue(key, this.spent)));
    this.stop.push(
      this.hub.onLog((entry) => {
        if (this.server.sockets.adapter.rooms.has(room(entry.key))) {
          this.server.to(room(entry.key)).emit('log', entry);
        }
      }),
    );
    this.stop.push(this.hub.onEvents((entry) => this.throttle(entry)));
    this.stop.push(
      this.hub.onBacklog((entry) => {
        this.server.emit('backlog', entry);
        this.markDoneDue();
      }),
    );
    this.stop.push(this.hub.onBacklogWritten(() => this.markDoneDue()));
    this.stop.push(this.gate.onChange((paused) => this.server.emit('server', { paused })));
  }

  onModuleDestroy(): void {
    for (const stop of this.stop) {
      stop();
    }
    clearTimeout(this.batchTimer);
    this.batch.clear();
    this.spent.clear();
    this.doneDue = false;
    this.flows.clear();
    for (const { timer } of this.eventWindows.values()) {
      clearTimeout(timer);
    }
  }

  async handleConnection(client: Socket<ClientToServerEvents, ServerToClientEvents>): Promise<void> {
    client.emit('server', { paused: this.gate.paused() });
    const { view } = await this.rows.read();
    if (!this.changes.hasBaseline()) {
      this.changes.reset(view);
    }
    client.emit('runs', pageOf(view.runs, { part: 'active', q: '' }));
    await this.sendDone(client, view);
  }

  /** The Done lately items to a new socket; the first connect sets what later changes are compared with. */
  private async sendDone(client: Socket<ClientToServerEvents, ServerToClientEvents>, view: RunsView): Promise<void> {
    try {
      const items = await this.doneLately.fromView(view);
      if (!this.doneChanges.hasBaseline()) {
        this.doneChanges.reset(items);
      }
      client.emit('done', items);
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : 'done lately failed');
    }
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
    await this.flows.watch(client, key);
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

  private queue(key: string, into: Set<string>): void {
    into.add(key);
    this.startBatch();
  }

  private markDoneDue(): void {
    this.doneDue = true;
    this.startBatch();
  }

  /** The one batch timer; a backlog change starts it too, since it can accept a milestone and move Done lately. */
  private startBatch(): void {
    this.batchTimer ??= setTimeout(() => {
      const keys = [...this.batch];
      const spent = [...this.spent];
      const doneDue = this.doneDue;
      this.batch.clear();
      this.spent.clear();
      this.doneDue = false;
      this.batchTimer = undefined;
      markEntered(`live update ${[...new Set([...keys, ...spent])].join(', ')}`);
      void this.publish(keys, spent, doneDue);
    }, BATCH_MS);
  }

  /**
   * Sends the changed rows to every socket and the flow of each run, and of its parent, to the room that watches it,
   * then one `usage` event per spent key. A spent key builds no flow and moves no finished item, so a batch of spent
   * keys alone reads no rows. Once a connect set the Done lately baseline, a batch with changed keys or a backlog change
   * works the items out once from the rows read and sends them when they changed. Nothing without a socket.
   */
  private async publish(keys: string[], spent: string[], doneDue: boolean): Promise<void> {
    if (this.server.sockets.sockets.size === 0) {
      return;
    }
    const started = this.clock.now();
    try {
      const dueDone = this.doneChanges.hasBaseline() && (keys.length > 0 || doneDue);
      const read = keys.length > 0 || dueDone ? await this.rows.read() : undefined;
      const { recomputed, built } =
        read && keys.length > 0 ? await this.publishChanged(keys, read) : { recomputed: 0, built: 0 };
      const sent = new Map<string, LiveRunUsage>();
      for (const key of spent) {
        for (const entry of await this.usage.entries(key)) {
          sent.set(entry.key, entry);
        }
      }
      for (const entry of sent.values()) {
        this.server.emit('usage', entry);
      }
      if (read && dueDone) {
        await this.publishDone(read.view);
      }
      const took = this.clock.now() - started;
      if (took > SLOW_PUBLISH_MS) {
        this.logger.warn(
          `live update of ${[...new Set([...keys, ...spent])].join(', ')} took ${took} ms, recomputed ${recomputed} rows and built ${built} flows`,
        );
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'live update failed';
      this.logger.error(message);
    }
  }

  /** The `run` event for the changed keys and the flows of the watched rooms; how many rows were recomputed and flows built. */
  private async publishChanged(
    keys: string[],
    { view, recomputed }: { view: RunsView; recomputed: number },
  ): Promise<{ recomputed: number; built: number }> {
    const { rows, removed } = this.changes.since(view, keys);
    if (rows.length > 0 || removed.length > 0) {
      this.server.emit('run', { rows, removed, counts: filterRuns(view.runs, '', 'all').counts });
    }
    this.flows.prune();
    let built = 0;
    for (const key of keys) {
      if (this.watched(key)) {
        built += 1;
        await this.flows.publish(key);
      }
    }
    // A subtask's step, cost and time show on its parent's page as its task section and figures.
    for (const parent of this.parentsToRefresh(keys, view.runs)) {
      if (this.flows.has(parent)) {
        await this.refreshTasks(parent);
      } else {
        built += 1;
        await this.flows.publish(parent);
      }
    }
    return { recomputed, built };
  }

  /** The `done` event to every socket, only when the items differ from the ones last sent. */
  private async publishDone(view: RunsView): Promise<void> {
    const items = this.doneChanges.since(await this.doneLately.fromView(view));
    if (items) {
      this.server.emit('done', items);
    }
  }

  private watched(key: string): boolean {
    return this.server.sockets.adapter.rooms.has(room(key));
  }

  /** The watched parents of the changed keys that did not change themselves, each once. */
  private parentsToRefresh(keys: string[], runs: Array<{ key: string; parentKey?: string }>): Set<string> {
    const parents = new Set<string>();
    for (const key of keys) {
      const parentKey = runs.find((row) => row.key === key)?.parentKey;
      if (parentKey && !keys.includes(parentKey) && this.watched(parentKey)) {
        parents.add(parentKey);
      }
    }
    return parents;
  }

  private async refreshTasks(parent: string): Promise<void> {
    const entry = (await this.usage.entries(parent)).find((item) => item.key === parent);
    if (entry) {
      const { tokens, usd, cpuPeak, memPeak } = entry;
      await this.flows.publishTasks(parent, { tokens, usd, cpuPeak, memPeak });
    }
  }
}
