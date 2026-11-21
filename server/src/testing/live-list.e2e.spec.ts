import 'reflect-metadata';
import { io, type Socket } from 'socket.io-client';
import type { RunSummary } from '../contract/api';
import { filterRuns, type Part, type RunChange, type RunsPage } from '../contract/run-list';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { SubtaskPort } from '../pipeline/subtask-port';
import { RunStateRefresh } from '../steps/shared/run-state-refresh';
import { createTestApp, type TestApp } from './test-app';
import { BlockAgentRunner, DEFAULT_RESEARCH } from './result-answer';
import { remember } from './runs.spec-helpers';

const KEY = 'PROJ-900';
/** The gateway sends a batch of changes after this long; the spec moves it with fake time. */
const BATCH_MS = 100;

/** The list a dashboard holds for one part and filter: a page from the API or the socket, then `run` events applied to it. */
class HeldList {
  runs: RunSummary[] = [];

  constructor(
    private readonly app: TestApp,
    readonly part: Part,
    readonly q: string,
  ) {}

  keys(): string[] {
    return this.runs.map((run) => run.key);
  }

  /** What the dashboard does on mount and on every reconnect: GET /runs for the shown part and filter. */
  async reload(): Promise<void> {
    const query = new URLSearchParams({ part: this.part, q: this.q });
    const response = await fetch(`${this.app.url}/runs?${query.toString()}`, { headers: this.app.auth });
    this.runs = ((await response.json()) as RunsPage).runs;
  }

  /** The `runs` event: a page of the Active part with no filter, ignored by any other view. */
  onRuns(page: RunsPage): void {
    if (this.part === 'active' && this.q === '') this.runs = page.runs;
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

describe('the run list follows a run to the end', () => {
  let app: TestApp;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    fakeBatchTimer();
    app = await createTestApp({
      socket: true,
      blocks: new BlockAgentRunner({ research: [{ block: { ...DEFAULT_RESEARCH, questions: ['Which field?'] } }] }),
    });
  });

  afterEach(async () => {
    jest.useRealTimers();
    for (const socket of sockets.splice(0)) socket.close();
    await app.close();
  });

  const runs = () => app.app.get(RunRepository);

  /** A socket with a session, feeding `held` as the dashboard does; every connect reads the view again. */
  async function open(held: HeldList): Promise<Socket> {
    const socket = io(app.url, {
      transports: ['websocket'],
      extraHeaders: await app.sessionCookie('person'),
      autoConnect: false,
    });
    sockets.push(socket);
    socket.on('runs', (page: RunsPage) => held.onRuns(page));
    socket.on('run', (change: RunChange) => held.onRun(change));
    let connects = 0;
    socket.on('connect', () => {
      connects += 1;
      if (connects > 1) void held.reload();
    });
    await connect(socket);
    await held.reload();
    return socket;
  }

  async function connect(socket: Socket): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      socket.once('runs', () => resolve());
      socket.once('connect_error', reject);
      socket.connect();
    });
  }

  /** Fake time moves the gateway's batch; then real turns of the event loop carry the answer to the clients. */
  async function pass(): Promise<void> {
    await jest.advanceTimersByTimeAsync(BATCH_MS);
    for (let turn = 0; turn < 300; turn++) await new Promise<void>((next) => setImmediate(next));
  }

  /** Timers are the only thing faked, from before the app starts, so no real batch timer is pending. */
  function fakeBatchTimer(): void {
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

  /** The pipeline holds the run while it works: the list shows a held run as running. */
  let held = true;

  async function start(): Promise<void> {
    held = true;
    jest.spyOn(app.pipeline, 'claimed').mockImplementation((key) => key === KEY && held);
    await remember(runs(), app.app.get(DocumentRepository), KEY, 'implement', 'running');
  }

  /** The run's row changes as the flow changes it: it is done, then its merge request merges. */
  async function finish(): Promise<void> {
    const run = (await runs().findRun(KEY))!;
    writeRunState(run, { status: 'done', currentStep: 'done' });
    await runs().saveRun(run);
    await pass();
    writeRunState(run, {
      status: 'done',
      currentStep: 'done',
      merge: { merged: { demo: { sha: 'abc', by: 'person', at: new Date().toISOString(), url: null } } },
    });
    await runs().saveRun(run);
    await pass();
    held = false;
    await pass();
  }

  it('(a) a connected client sees the run leave Active and show under Done', async () => {
    await start();
    const active = new HeldList(app, 'active', '');
    const done = new HeldList(app, 'done', '');
    await open(active);
    await open(done);
    expect(active.keys()).toEqual([KEY]);
    expect(done.keys()).toEqual([]);

    await finish();

    expect(active.keys()).toEqual([]);
    expect(done.keys()).toEqual([KEY]);
  });

  it('(b) a client away while the run finishes sees it under Done once it is back', async () => {
    await start();
    const done = new HeldList(app, 'done', '');
    const socket = await open(done);
    socket.disconnect();

    await finish();
    await connect(socket);
    await pass();

    expect(done.keys()).toEqual([KEY]);
    expect(done.runs.map((run) => run.state)).toEqual(['merged']);
  });

  it('(c) clients holding Done with a filter, All and Active with a filter all follow the run', async () => {
    await start();
    const doneFiltered = new HeldList(app, 'done', 'ship');
    const all = new HeldList(app, 'all', '');
    const activeFiltered = new HeldList(app, 'active', 'ship');
    await open(doneFiltered);
    await open(all);
    await open(activeFiltered);
    expect(activeFiltered.keys()).toEqual([KEY]);
    expect(all.keys()).toEqual([KEY]);
    expect(doneFiltered.keys()).toEqual([]);

    await finish();

    expect(activeFiltered.keys()).toEqual([]);
    expect(doneFiltered.keys()).toEqual([KEY]);
    expect(all.runs.map((run) => run.state)).toEqual(['merged']);
  });

  it('(d) a held run that stops waiting with open questions shows waiting for a person once its claim ends', async () => {
    // The pipeline still holds the run after its step wrote everything, until the driver is let go.
    let letGo: () => void = () => undefined;
    const holding = new Promise<void>((resolve) => (letGo = resolve));
    jest.spyOn(app.app.get(SubtaskPort), 'notifyParent').mockImplementationOnce(() => holding);
    await remember(runs(), app.app.get(DocumentRepository), KEY, 'research', 'waiting');
    await app.pipeline.startDetached(KEY);
    const active = new HeldList(app, 'active', '');
    await open(active);

    await app.app.get(RunStateRefresh).settled();
    await pass();
    expect(active.runs.map((item) => item.state)).toEqual(['running']);

    letGo();
    await app.pipeline.whenIdle(KEY);
    await pass();

    expect(active.runs.map((item) => [item.state, item.stateReason?.code])).toEqual([['waiting', 'NEEDS_ANSWERS']]);
  });
});
