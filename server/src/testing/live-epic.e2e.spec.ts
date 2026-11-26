import 'reflect-metadata';
import { storeRun } from './store-run.spec-helpers';
import type { Socket } from 'socket.io-client';
import type { FlowView } from '../contract/api';
import type { RunEntity } from '../history/entities';
import { AgentCallRepository } from '../history/agent-call.repository';
import { seedCall } from '../history/agent-call.spec-helpers';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { writeRunState } from '../history/run-state';
import { LiveHub } from '../live/live.hub';
import { connect, fakeBatchTimer, HeldRunPage, pass } from './live-clients.spec-helpers';
import { remember, visit } from './runs.spec-helpers';
import { createTestApp, type TestApp } from './test-app';

const PARENT = 'PROJ-920';
const A = `${PARENT}-a`;
const B = `${PARENT}-b`;

describe('the epic page follows its subtasks', () => {
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

  /** A parent with a split plan (b waits for a) and a run for each task: a works at implement, b has not started. */
  async function seedEpic(): Promise<{ page: HeldRunPage; socket: Socket }> {
    const parent = await remember(runs(), documents(), PARENT, 'implement', 'running');
    await documents().putDocument(
      parent,
      'requirements',
      JSON.stringify({ prompt: 'x', plan: { items: ['x'], decision: 'approve' } }),
    );
    const task = (id: string, depends: string[]) => ({
      id,
      title: `Task ${id}`,
      description: '',
      depends,
      files: [],
      proof: '',
      status: 'waiting',
    });
    await documents().putDocument(parent, 'subtasks', JSON.stringify([task('a', []), task('b', ['a'])]));
    const first = await runs().openSubtask(A, parent.id, 'a');
    writeRunState(first, { status: 'running', currentStep: 'implement' });
    await storeRun(runs(), first);
    await runs().openSubtask(B, parent.id, 'b');
    const page = new HeldRunPage(app, PARENT);
    return { page, socket: await page.open(sockets) };
  }

  /** The subtask's run changes alone: the parent's own record, phases and task list stay as they are. */
  async function change(key: string, update: (run: RunEntity) => Promise<void> | void): Promise<void> {
    const run = (await runs().findRun(key))!;
    await update(run);
    await pass();
  }

  async function awayDuring(socket: Socket, work: () => Promise<void>): Promise<void> {
    socket.disconnect();
    await work();
    await connect(socket);
    await pass();
  }

  /** What the page shows of the tasks and the epic is what a fresh read of the same run gives. */
  async function expectFresh(page: HeldRunPage): Promise<FlowView> {
    const fresh = await page.read();
    expect(page.flow?.tasks).toEqual(fresh.tasks);
    expect(page.flow?.taskLine).toEqual(fresh.taskLine);
    expect(page.flow?.eta).toEqual(fresh.eta);
    expect(page.flow?.epic).toEqual(fresh.epic);
    return fresh;
  }

  const taskA = (page: HeldRunPage) => page.flow?.tasks?.find((task) => task.id === 'a');
  const move = (status: string, currentStep: string, reason?: object) => async (run: RunEntity) => {
    writeRunState(run, { status, currentStep });
    run.stateReason = reason ? JSON.stringify(reason) : null;
    await storeRun(runs(), run);
  };

  it("updates a task's step, estimate, note and waits-for, and the epic's estimate, on a subtask's step change alone", async () => {
    const { page, socket } = await seedEpic();
    const parentBefore = page.flow!;
    expect(taskA(page)?.run).toMatchObject({ state: 'running', currentStep: 'implement' });
    expect(taskA(page)).not.toHaveProperty('waitsFor');

    await change(A, move('running', 'code-review'));
    expect(taskA(page)?.run?.currentStep).toBe('code-review');
    expect(taskA(page)?.eta).not.toEqual(parentBefore.tasks?.find((task) => task.id === 'a')?.eta);
    expect(page.flow?.eta).not.toEqual(parentBefore.eta);
    expect(page.flow?.currentStep).toBe(parentBefore.currentStep);
    await expectFresh(page);

    const limit = {
      code: 'RUNTIME_LIMIT',
      message: 'limit',
      limit: { runtime: 'x', resumesAt: '2026-11-13T10:00:00Z' },
    };
    await change(A, move('waiting', 'requirements', limit));
    expect(taskA(page)).toMatchObject({
      status: 'waiting',
      waitsFor: [],
      note: 'a waits for the agent limit; next try at 2026-11-13T10:00:00Z',
    });
    await expectFresh(page);

    await awayDuring(socket, async () => move('running', 'checks')((await runs().findRun(A))!));
    expect(taskA(page)?.run).toMatchObject({ currentStep: 'checks' });
    expect(taskA(page)).not.toHaveProperty('waitsFor');
    await expectFresh(page);
  });

  it("updates a task's run.interruption when its latest visit was cut by a server restart, on that subtask's change alone", async () => {
    const { page, socket } = await seedEpic();
    expect(taskA(page)?.run).not.toHaveProperty('interruption');
    const cut = (at: string) => async (run: RunEntity) => {
      await app.app.get(VisitRepository).finishVisit(run, {
        ...visit('implement', 'failed'),
        killReason: 'process died',
        documents: [{ kind: 'interruption', fileName: '', body: JSON.stringify({ at, relaunched: true }) }],
      });
    };

    await change(A, cut('2026-11-21T10:00:00Z'));
    expect(taskA(page)?.run?.interruption).toEqual({ at: '2026-11-21T10:00:00Z', relaunched: true });
    await expectFresh(page);

    await awayDuring(socket, async () => cut('2026-11-21T11:00:00Z')((await runs().findRun(A))!));
    const fresh = await expectFresh(page);
    expect(fresh.tasks?.find((task) => task.id === 'a')?.run?.interruption?.at).toBe('2026-11-21T11:00:00Z');
  });

  it("updates a task's run.result when the subtask gets its merge request and merged files, on that subtask's change alone", async () => {
    const { page, socket } = await seedEpic();
    expect(taskA(page)?.run).not.toHaveProperty('result');

    await change(A, async (run) => documents().putDocument(run, 'merge_request', 'https://host.example/mr/1\n'));
    await change(A, async (run) => documents().putDocument(run, 'merged_files', 'src/a.ts\nsrc/b.ts'));
    expect(taskA(page)?.run?.result).toEqual({ files: ['src/a.ts', 'src/b.ts'], proofMet: null });
    await expectFresh(page);

    await awayDuring(socket, async () =>
      documents().putDocument((await runs().findRun(A))!, 'merged_files', 'src/a.ts\nsrc/b.ts\nsrc/c.ts'),
    );
    const fresh = await expectFresh(page);
    expect(fresh.tasks?.find((task) => task.id === 'a')?.run?.result?.files).toHaveLength(3);
  });

  it("updates the epic's cost and the task's cost after a subtask's usage log", async () => {
    const { page, socket } = await seedEpic();
    /** One more model request of the task's visit: its row is saved first, then the stream tells the page. */
    const usage = async (usd: number) => {
      await seedCall(app.app.get(AgentCallRepository), { runKey: A, step: 'implement', usd, input: 10, output: 5 });
      app.app
        .get(LiveHub)
        .log({ key: A, step: 'implement', body: 'working\n', usage: { tokensIn: 10, tokensOut: 5, usd } });
    };
    const before = page.flow!.epic!.usd;

    await usage(0.75);
    await pass();
    expect(taskA(page)?.run?.usd).toBe(0.75);
    expect(page.flow!.epic!.usd).toBeCloseTo(before + 0.75);
    await expectFresh(page);

    await awayDuring(socket, () => usage(1.25));
    expect(taskA(page)?.run?.usd).toBe(2);
    await expectFresh(page);
  });
});
