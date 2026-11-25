import { io, type Socket } from 'socket.io-client';
import type { FlowView, RunSummary } from '../contract/api';
import type { LiveEvents, LiveLog, LiveRunUsage } from '../contract/live';
import { filterRuns, type Part, type RunChange, type RunsPage } from '../contract/run-list';
import type { TestApp } from './test-app';

/** The gateway sends a batch of changes after this long; a spec moves it with fake time. */
export const BATCH_MS = 100;

/** The list a dashboard holds for one part and filter: a page from the API or the socket, then `run` events applied to it. */
export class HeldList {
  runs: RunSummary[] = [];

  constructor(
    private readonly app: TestApp,
    readonly part: Part,
    readonly q: string,
  ) {}

  keys(): string[] {
    return this.runs.map((run) => run.key);
  }

  /**
   * What the dashboard does on mount and on every reconnect: GET /runs for the shown part and filter.
   * This mirrors the client; the reconnect reload itself is reproduced in use-runs.test.tsx.
   */
  async reload(): Promise<void> {
    const query = new URLSearchParams({ part: this.part, q: this.q });
    const response = await fetch(`${this.app.url}/runs?${query.toString()}`, { headers: this.app.auth });
    this.runs = ((await response.json()) as RunsPage).runs;
  }

  /** The `runs` event: a page of the Active part with no filter, ignored by any other view. */
  onRuns(page: RunsPage): void {
    if (this.part === 'active' && this.q === '') this.runs = page.runs;
  }

  /** The `usage` event, by the rule of the dashboard's apply-usage: the row of the run takes the cost, and the epic total when the entry has one. */
  onUsage(entry: LiveRunUsage): void {
    this.runs = this.runs.map((run) =>
      run.key === entry.key ? { ...run, usd: entry.usd, ...(entry.epic ? { epic: entry.epic } : {}) } : run,
    );
  }

  /** The `run` event, by the rule of the dashboard's apply-run-change: changed rows replace or join, removed ones go, the view filters. */
  onRun(change: RunChange): void {
    const removed = new Set(change.removed);
    const changed = new Map(change.rows.map((row) => [row.key, row]));
    const held = this.runs.filter((run) => !removed.has(run.key)).map((run) => changed.get(run.key) ?? run);
    const heldKeys = new Set(held.map((run) => run.key));
    const joined = change.rows.filter((row) => !heldKeys.has(row.key) && !removed.has(row.key));
    this.runs = filterRuns([...held, ...joined], this.q, this.part).visible;
  }
}

/**
 * The run page a dashboard holds for one run: it watches the run on every connect, as use-live-bridge does, and takes the
 * flow the server sends on watch and on every `flow` event, the latest `log` per step (and command) and the latest `events`.
 */
export class HeldRunPage {
  flow: FlowView | null = null;
  logs: LiveLog[] = [];
  events: LiveEvents | null = null;

  constructor(
    private readonly app: TestApp,
    readonly key: string,
  ) {}

  /** What the dashboard reads for the page: GET /runs/:key. */
  async read(): Promise<FlowView> {
    const response = await fetch(`${this.app.url}/runs/${this.key}`, { headers: this.app.auth });
    return (await response.json()) as FlowView;
  }

  /** The step window's read: GET /runs/:key/steps/:step. */
  async readStep<T>(step: string): Promise<T> {
    const response = await fetch(`${this.app.url}/runs/${this.key}/steps/${step}`, { headers: this.app.auth });
    return (await response.json()) as T;
  }

  /** The latest log of a step, as the bridge keeps it: one per step, and per command for the checks step. */
  logOf(step: string, command?: number): LiveLog | undefined {
    return this.logs.find((entry) => entry.step === step && entry.command === command);
  }

  /** The `usage` event, by the rule of the dashboard's flow-usage: numbers are replaced on the page's own run and on its task runs, never added. */
  onUsage(entry: LiveRunUsage): void {
    const flow = this.flow;
    if (!flow) return;
    if (entry.key === flow.key) {
      const { tokens, usd, cpuPeak, memPeak } = entry;
      this.flow = {
        ...flow,
        metrics: { ...flow.metrics, tokens, usd, cpuPeak, memPeak },
        ...(entry.epic ? { epic: entry.epic } : {}),
      };
    } else if (flow.tasks?.some((task) => task.run?.key === entry.key)) {
      this.flow = {
        ...flow,
        tasks: flow.tasks.map((task) =>
          task.run?.key === entry.key ? { ...task, run: { ...task.run, usd: entry.usd } } : task,
        ),
      };
    }
  }

  /** Connects a socket with a session; every connect, the first included, asks to watch the run. */
  async open(sockets: Socket[]): Promise<Socket> {
    const socket = await newSocket(this.app, sockets);
    socket.on('flow', (view: FlowView) => {
      if (view.key === this.key) this.flow = view;
    });
    socket.on('log', (entry: LiveLog) => {
      if (entry.key !== this.key) return;
      this.logs = [...this.logs.filter((item) => item.step !== entry.step || item.command !== entry.command), entry];
    });
    socket.on('usage', (entry: LiveRunUsage) => this.onUsage(entry));
    socket.on('events', (entry: LiveEvents) => {
      if (entry.key === this.key) this.events = entry;
    });
    socket.on('connect', () => socket.emit('watch', this.key));
    await connect(socket);
    await pass();
    return socket;
  }
}

export async function newSocket(app: TestApp, sockets: Socket[]): Promise<Socket> {
  const socket = io(app.url, {
    transports: ['websocket'],
    extraHeaders: await app.sessionCookie('person'),
    autoConnect: false,
  });
  sockets.push(socket);
  return socket;
}

/** A socket with a session, feeding `held` as the dashboard does; every connect reads the view again. */
export async function open(app: TestApp, sockets: Socket[], held: HeldList): Promise<Socket> {
  const socket = await newSocket(app, sockets);
  socket.on('runs', (page: RunsPage) => held.onRuns(page));
  socket.on('run', (change: RunChange) => held.onRun(change));
  socket.on('usage', (entry: LiveRunUsage) => held.onUsage(entry));
  let connects = 0;
  socket.on('connect', () => {
    connects += 1;
    if (connects > 1) void held.reload();
  });
  await connect(socket);
  await held.reload();
  return socket;
}

export async function connect(socket: Socket): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    socket.once('runs', () => resolve());
    socket.once('connect_error', reject);
    socket.connect();
  });
}

/** Fake time moves the gateway's batch; then real turns of the event loop carry the answer to the clients. */
export async function pass(): Promise<void> {
  await jest.advanceTimersByTimeAsync(BATCH_MS);
  for (let turn = 0; turn < 300; turn++) await new Promise<void>((next) => setImmediate(next));
}

/** Timers are the only thing faked, from before the app starts, so no real batch timer is pending. */
export function fakeBatchTimer(): void {
  jest.useFakeTimers({
    doNotFake: [
      'Date',
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
    ],
  });
}
