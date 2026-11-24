import 'reflect-metadata';
import type { Socket } from 'socket.io-client';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { SubtaskPort } from '../pipeline/subtask-port';
import { RunStateRefresh } from '../steps/shared/run-state-refresh';
import { createTestApp, type TestApp } from './test-app';
import { BlockAgentRunner, DEFAULT_RESEARCH } from './result-answer';
import { connect, fakeBatchTimer, HeldList, open, pass } from './live-clients.spec-helpers';
import { remember } from './runs.spec-helpers';

const KEY = 'PROJ-900';

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
    await open(app, sockets, active);
    await open(app, sockets, done);
    expect(active.keys()).toEqual([KEY]);
    expect(done.keys()).toEqual([]);

    await finish();

    expect(active.keys()).toEqual([]);
    expect(done.keys()).toEqual([KEY]);
  });

  it('(b) a client away while the run finishes sees it under Done once it is back', async () => {
    await start();
    const done = new HeldList(app, 'done', '');
    const socket = await open(app, sockets, done);
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
    await open(app, sockets, doneFiltered);
    await open(app, sockets, all);
    await open(app, sockets, activeFiltered);
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
    await open(app, sockets, active);

    await app.app.get(RunStateRefresh).settled();
    await pass();
    expect(active.runs.map((item) => item.state)).toEqual(['running']);

    letGo();
    await app.pipeline.whenIdle(KEY);
    await pass();

    expect(active.runs.map((item) => [item.state, item.stateReason?.code])).toEqual([['waiting', 'NEEDS_ANSWERS']]);
  });
});
