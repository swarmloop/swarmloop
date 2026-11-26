import 'reflect-metadata';
import { storeRun } from './store-run.spec-helpers';
import type { Socket } from 'socket.io-client';
import type { RunSummary } from '../contract/api';
import type { LiveBacklog } from '../contract/backlog-chat';
import type { PartCounts, RunChange, RunsPage } from '../contract/run-list';
import type { ServerState } from '../contract/server-pause';
import { PeopleService } from '../auth/people.service';
import { BacklogRepository, type BacklogTaskRecord } from '../history/backlog.repository';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { LiveHub } from '../live/live.hub';
import { ContainerGate } from '../sandbox/container-gate';
import { connect, fakeBatchTimer, newSocket, pass } from './live-clients.spec-helpers';
import { remember } from './runs.spec-helpers';
import { createTestApp, type TestApp } from './test-app';

const KEY = 'PROJ-930';
const NOW = '2026-11-21T10:00:00Z';

/**
 * What the dashboard's live bridge keeps besides the lists, by the rules of use-live-bridge: the counts, the stamp that moves
 * when a run's status changes or a run goes (Overview and Stats reload on it), a stamp per backlog that moves when its
 * conversation or a labelled run's shown state changes, and the pause flag.
 */
class HeldShell {
  counts: PartCounts = { active: 0, done: 0, all: 0 };
  statusStamp = 0;
  backlogStamps: Record<string, number> = {};
  paused = false;
  active: RunSummary[] = [];
  /** The title the history page shows, from the held rows. */
  titles = new Map<string, string>();
  private readonly statuses = new Map<string, string>();
  private readonly labelled = new Map<string, string>();

  constructor(private readonly app: TestApp) {}

  async open(sockets: Socket[]): Promise<Socket> {
    const socket = await newSocket(this.app, sockets);
    socket.on('runs', (page: RunsPage) => {
      page.runs.forEach((run) => this.statuses.set(run.key, run.status));
      page.runs.forEach((run) => this.titles.set(run.key, run.title));
      this.counts = page.counts;
      this.active = page.runs;
    });
    socket.on('run', (change) => this.onRun(change));
    socket.on('backlog', (entry: LiveBacklog) => this.bump([entry.backlog]));
    socket.on('server', (state: ServerState) => (this.paused = state.paused));
    await connect(socket);
    await pass();
    return socket;
  }

  private onRun(change: RunChange): void {
    const moved =
      change.removed.some((key) => this.statuses.delete(key)) ||
      change.rows.some((run) => this.statuses.get(run.key) !== run.status);
    change.rows.forEach((run) => this.statuses.set(run.key, run.status));
    change.rows.forEach((run) => this.titles.set(run.key, run.title));
    if (moved) this.statusStamp += 1;
    for (const run of change.rows) {
      if (!run.backlog) continue;
      const shown = JSON.stringify([run.status, run.state, run.currentStep, run.backlog]);
      if (this.labelled.get(run.key) !== shown) this.bump([run.backlog.name]);
      this.labelled.set(run.key, shown);
    }
    this.counts = change.counts;
  }

  private bump(names: string[]): void {
    for (const name of names) this.backlogStamps[name] = (this.backlogStamps[name] ?? 0) + 1;
  }
}

/** The account button of the dashboard: it reads `/auth/me` on a connect that follows an earlier one, as account.tsx does. */
class HeldAccount {
  me: { user: string | null; avatarUrl?: string | null } | null = null;
  /** The latest read the client started on a connect. */
  reading: Promise<void> = Promise.resolve();
  private connects = 0;

  constructor(
    private readonly app: TestApp,
    private readonly cookie: string,
  ) {}

  async open(sockets: Socket[]): Promise<Socket> {
    const socket = await newSocket(this.app, sockets);
    socket.on('connect', () => {
      this.connects += 1;
      if (this.connects > 1) this.reading = this.read();
    });
    await connect(socket);
    await pass();
    return socket;
  }

  async read(): Promise<void> {
    const response = await fetch(`${this.app.url}/auth/me`, { headers: { cookie: this.cookie } });
    this.me = (await response.json()) as typeof this.me;
  }
}

describe('the shell follows the server', () => {
  let app: TestApp;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    fakeBatchTimer();
    app = await createTestApp({ socket: true });
  });

  afterEach(async () => {
    jest.useRealTimers();
    for (const socket of sockets.splice(0)) socket.close();
    await app.close();
  });

  const runs = () => app.app.get(RunRepository);

  async function start(key = KEY): Promise<void> {
    await remember(runs(), app.app.get(DocumentRepository), key, 'implement', 'running');
  }

  async function moveTo(status: string, currentStep: string, key = KEY): Promise<void> {
    const run = (await runs().findRun(key))!;
    writeRunState(run, { status, currentStep });
    await storeRun(runs(), run);
    await pass();
  }

  async function read(part: string): Promise<RunsPage> {
    const response = await fetch(`${app.url}/runs?part=${part}&q=`, { headers: app.auth });
    return (await response.json()) as RunsPage;
  }

  async function awayDuring(socket: Socket, work: () => Promise<void>): Promise<void> {
    socket.disconnect();
    await work();
    await connect(socket);
    await pass();
  }

  it('follows the part counts as runs come and finish, and after a reconnect reads what a fresh read counts', async () => {
    const shell = new HeldShell(app);
    const socket = await shell.open(sockets);
    expect(shell.counts).toEqual({ active: 0, done: 0, all: 0 });

    await start();
    await pass();
    expect(shell.counts).toEqual({ active: 1, done: 0, all: 1 });

    await moveTo('done', 'done');
    expect(shell.counts).toEqual({ active: 0, done: 1, all: 1 });

    await awayDuring(socket, () => start('PROJ-931'));
    expect(shell.counts).toEqual((await read('all')).counts);
    expect(shell.counts).toEqual({ active: 1, done: 1, all: 2 });
  });

  it('moves the status stamp on a status change and on a new run, and not on a change that leaves the status', async () => {
    const shell = new HeldShell(app);
    const socket = await shell.open(sockets);

    await start();
    await pass();
    expect(shell.statusStamp).toBe(1);

    await moveTo('running', 'checks');
    expect(shell.statusStamp).toBe(1);
    const run = (await runs().findRun(KEY))!;
    await storeRun(runs(), run);
    await pass();
    expect(shell.statusStamp).toBe(1);

    await moveTo('done', 'done');
    expect(shell.statusStamp).toBe(2);

    await awayDuring(socket, () => start('PROJ-931'));
    expect(shell.active.map((row) => [row.key, row.status])).toEqual(
      (await read('active')).runs.map((row) => [row.key, row.status]),
    );
  });

  it('follows the title of a run after one batch, and after a reconnect reads what a fresh read shows', async () => {
    await start();
    const shell = new HeldShell(app);
    const socket = await shell.open(sockets);

    const retitle = async (title: string): Promise<void> => {
      const run = (await runs().findRun(KEY))!;
      await runs().recordTitle(run, title);
      await storeRun(runs(), run);
    };
    await retitle('First title');
    await pass();
    expect(shell.titles.get(KEY)).toBe('First title');

    await awayDuring(socket, () => retitle('Second title'));
    const fresh = (await read('all')).runs.find((row) => row.key === KEY);
    expect(fresh?.title).toBe('Second title');
    expect(shell.titles.get(KEY)).toBe(fresh?.title);
  });

  describe('a backlog', () => {
    const task = (backlogId: number, runKey: string): BacklogTaskRecord => ({
      backlogId,
      milestoneId: null,
      slug: 'ship',
      title: 'Ship the field',
      description: '',
      repositories: ['demo'],
      covers: [],
      depends: [],
      files: [],
      proof: [],
      manual: false,
      fixesMain: null,
      status: 'running',
      runKey,
      note: '',
      runNow: false,
      mergeOk: false,
      merged: {},
      madeBy: 'planner',
      position: 1,
      createdAt: NOW,
    });

    async function labelRun(): Promise<void> {
      const backlogs = app.app.get(BacklogRepository);
      const backlog = await backlogs.saveBacklog({
        name: 'swarmloop',
        owner: 'ada',
        repositories: ['demo'],
        mergeMode: 'ok',
        paused: false,
        createdAt: NOW,
      });
      await backlogs.saveTask(task(backlog.id as number, KEY));
    }

    it('moves its stamp after hub.backlog, and after a reconnect a fresh read shows the run labelled', async () => {
      await start();
      const shell = new HeldShell(app);
      const socket = await shell.open(sockets);

      app.app.get(LiveHub).backlog({ backlog: 'swarmloop' });
      await pass();
      expect(shell.backlogStamps).toEqual({ swarmloop: 1 });

      await awayDuring(socket, async () => labelRun());
      expect((await read('all')).runs.find((row) => row.key === KEY)?.backlog).toEqual({
        name: 'swarmloop',
        milestone: null,
      });
    });

    it("moves its stamp when a labelled run's shown state changes, and not when a resent row is equal", async () => {
      await start();
      const shell = new HeldShell(app);
      await shell.open(sockets);
      await labelRun();
      await pass();
      expect(shell.backlogStamps).toEqual({ swarmloop: 1 });

      const run = (await runs().findRun(KEY))!;
      await storeRun(runs(), run);
      await pass();
      expect(shell.backlogStamps).toEqual({ swarmloop: 1 });

      await moveTo('running', 'checks');
      expect(shell.backlogStamps).toEqual({ swarmloop: 2 });
    });
  });

  it('shows the pause banner after the gate pauses and after it resumes, and on reconnect as a fresh read does', async () => {
    const shell = new HeldShell(app);
    const socket = await shell.open(sockets);
    const gate = app.app.get(ContainerGate);
    expect(shell.paused).toBe(false);

    gate.pause();
    await pass();
    expect(shell.paused).toBe(true);
    gate.resume();
    await pass();
    expect(shell.paused).toBe(false);

    await awayDuring(socket, async () => gate.pause());
    const health = await fetch(`${app.url}/health`);
    expect(shell.paused).toBe(((await health.json()) as { paused: boolean }).paused);
    expect(shell.paused).toBe(true);
  });

  it('reads the person again after a reconnect, with the photo stored at the latest login', async () => {
    const people = app.app.get(PeopleService);
    await people.seen('ann', 'https://avatars.test/ann.png');
    const account = new HeldAccount(app, (await app.sessionCookie('ann')).cookie);
    const socket = await account.open(sockets);
    await account.read();
    expect(account.me).toMatchObject({ user: 'ann', avatarUrl: 'https://avatars.test/ann.png' });

    await awayDuring(socket, () => people.seen('ann', 'https://avatars.test/ann-2.png'));
    await account.reading;
    expect(account.me).toMatchObject({ user: 'ann', avatarUrl: 'https://avatars.test/ann-2.png' });
  });
});
