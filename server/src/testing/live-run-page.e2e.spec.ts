import 'reflect-metadata';
import { storeRun } from './store-run.spec-helpers';
import type { Socket } from 'socket.io-client';
import type { StepView } from '../contract/api';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { writeRunState } from '../history/run-state';
import { LiveHub } from '../live/live.hub';
import { connect, fakeBatchTimer, HeldRunPage, pass } from './live-clients.spec-helpers';
import { remember, visit } from './runs.spec-helpers';
import { createTestApp, type TestApp } from './test-app';

const KEY = 'PROJ-910';

describe('the run page follows its run', () => {
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
  const documents = () => app.app.get(DocumentRepository);
  const hub = () => app.app.get(LiveHub);

  async function start(): Promise<{ page: HeldRunPage; socket: Socket }> {
    await remember(runs(), documents(), KEY, 'implement', 'running');
    const page = new HeldRunPage(app, KEY);
    const socket = await page.open(sockets);
    return { page, socket };
  }

  /** The client is away while `change` happens, then connects again and asks to watch the run. */
  async function awayDuring(socket: Socket, change: () => Promise<void>): Promise<void> {
    socket.disconnect();
    await change();
    await connect(socket);
    await pass();
  }

  async function moveTo(status: string, currentStep: string): Promise<void> {
    const run = (await runs().findRun(KEY))!;
    writeRunState(run, { status, currentStep });
    await storeRun(runs(), run);
  }

  const spend = (usd: number) =>
    hub().log({ key: KEY, step: 'implement', body: 'working\n', usage: { tokensIn: 100, tokensOut: 50, usd } });

  it('shows the header status after a step change, and after a reconnect as a fresh read does', async () => {
    const { page, socket } = await start();
    expect(page.flow?.status).toBe('running');

    await moveTo('running', 'code-review');
    await pass();
    expect(page.flow).toMatchObject({ status: 'running', currentStep: 'code-review' });

    await awayDuring(socket, () => moveTo('done', 'done'));
    const fresh = await page.read();
    expect(fresh.status).toBe('done');
    expect(page.flow).toMatchObject({ status: fresh.status, currentStep: fresh.currentStep, revision: fresh.revision });
  });

  it('shows tokens and usd after a log with usage, and after a reconnect as a fresh read does', async () => {
    const { page, socket } = await start();

    spend(0.5);
    await pass();
    expect(page.flow?.metrics).toMatchObject({ tokens: 150, usd: 0.5 });

    await awayDuring(socket, async () => spend(1.25));
    const fresh = await page.read();
    expect(fresh.metrics.usd).toBe(1.25);
    expect(page.flow?.metrics).toMatchObject({ tokens: fresh.metrics.tokens, usd: fresh.metrics.usd });
  });

  it('shows the board after a step change, and after a reconnect as a fresh read does', async () => {
    const { page, socket } = await start();
    const current = (phases: NonNullable<typeof page.flow>['phases']) =>
      phases.flatMap((phase) => phase.steps).find((step) => step.current)?.name;
    expect(current(page.flow!.phases)).toBe('implement');

    await moveTo('running', 'checks');
    await pass();
    expect(current(page.flow!.phases)).toBe('checks');

    await awayDuring(socket, () => moveTo('running', 'commit'));
    const fresh = await page.read();
    expect(current(fresh.phases)).toBe('commit');
    expect(page.flow?.phases).toEqual(fresh.phases);
  });

  it('moves the held revision on a step change, so the step reread shows the new visit, and shows a log line', async () => {
    const { page, socket } = await start();
    const before = page.flow!.revision;
    const stored = async () =>
      (await page.readStep<StepView>('implement')).visits.filter((item) => item.key.startsWith('visit-'));
    expect(await stored()).toHaveLength(0);

    const run = (await runs().findRun(KEY))!;
    writeRunState(run, { status: 'running', currentStep: 'checks' });
    await app.app.get(VisitRepository).finalize(run.activeAttempt, run, visit('implement', 'done'));
    await pass();
    expect(page.flow!.revision).toBeGreaterThan(before);
    expect(await stored()).toHaveLength(1);

    hub().log({ key: KEY, step: 'checks', body: 'running the checks\n' });

    await pass();
    expect(page.logOf('checks')?.body).toBe('running the checks\n');

    await awayDuring(socket, () => moveTo('running', 'commit'));
    expect(page.flow!.revision).toBe((await page.read()).revision);
  });

  it('shows the lines of a check command from its log, each command on its own', async () => {
    const { page, socket } = await start();

    hub().log({ key: KEY, step: 'checks', command: 0, body: 'lint ok\n' });

    await pass();
    hub().log({ key: KEY, step: 'checks', command: 1, body: 'tests start\n' });
    await pass();
    hub().log({ key: KEY, step: 'checks', command: 1, body: 'tests pass\n' });
    await pass();
    expect(page.logOf('checks', 0)?.body).toBe('lint ok\n');
    expect(page.logOf('checks', 1)?.body).toBe('tests pass\n');

    await awayDuring(socket, async () => undefined);
    hub().log({ key: KEY, step: 'checks', command: 1, body: 'tests pass again\n' });
    await pass();
    expect(page.logOf('checks', 1)?.body).toBe('tests pass again\n');
  });

  it('shows a conversation message after a document write, and after a reconnect as a fresh read does', async () => {
    const { page, socket } = await start();
    const message = (text: string) => ({
      key: `message-${text}`,
      role: 'person',
      text,
      at: '2026-11-21T10:00:00Z',
      state: 'taken',
    });
    const write = async (...texts: string[]) =>
      documents().putDocument(
        (await runs().findRun(KEY))!,
        'plan_chat',
        JSON.stringify({ entries: texts.map(message), revisions: [] }),
      );

    await write('first');
    await pass();
    expect(page.flow?.conversation?.entries.map((entry) => entry.text)).toEqual(['first']);

    await awayDuring(socket, () => write('first', 'second'));
    const fresh = await page.read();
    expect(fresh.conversation?.entries.map((entry) => entry.text)).toEqual(['first', 'second']);
    expect(page.flow?.conversation).toEqual(fresh.conversation);
  });

  it('shows the latest log of a step at once, and goes on showing logs after a reconnect', async () => {
    const { page, socket } = await start();

    hub().log({ key: KEY, step: 'implement', body: 'one\n' });

    await pass();
    hub().log({ key: KEY, step: 'implement', body: 'one\ntwo\n' });
    await pass();
    expect(page.logs.map((entry) => entry.body)).toEqual(['one\ntwo\n']);

    await awayDuring(socket, async () => undefined);
    hub().log({ key: KEY, step: 'implement', body: 'one\ntwo\nthree\n' });
    await pass();
    expect(page.logOf('implement')?.body).toBe('one\ntwo\nthree\n');
  });

  it('shows the events timeline once the 500 ms window ends, with the latest message of the window', async () => {
    const { page, socket } = await start();

    hub().appended({ key: KEY, step: 'implement', seq: 1 });
    hub().appended({ key: KEY, step: 'implement', seq: 2 });
    await jest.advanceTimersByTimeAsync(499);
    expect(page.events).toBeNull();
    await jest.advanceTimersByTimeAsync(1);
    await pass();
    expect(page.events).toEqual({ key: KEY, step: 'implement', seq: 2 });

    await awayDuring(socket, async () => undefined);
    hub().appended({ key: KEY, step: 'implement', seq: 3 });
    await jest.advanceTimersByTimeAsync(500);
    await pass();
    expect(page.events?.seq).toBe(3);
  });
});
