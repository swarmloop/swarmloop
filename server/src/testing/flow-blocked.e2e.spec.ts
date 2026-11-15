import 'reflect-metadata';
import { interruptionSentence, type InterruptionNote } from '../contract/interruption';
import { parseSubtasks, type Subtask } from '../contract/subtask';
import { PipelineService } from '../pipeline/pipeline.service';
import { RunQueriesService } from '../api/run-queries.service';
import { CommandRepository } from '../history/command.repository';
import { VisitRepository } from '../history/visit.repository';
import { DocumentRepository } from '../history/document.repository';
import { CommandService } from '../pipeline/command.service';
import { RunRepository } from '../history/run.repository';
import { deriveState, writeRunState } from '../history/run-state';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { installScripts } from '../pipeline/run-driver.spec-helpers';
import { save, visit } from './runs.spec-helpers';
import type { TestApp } from './test-app';

const KEY = 'PROJ-420';

const task = (id: string, depends: string[] = []): Subtask => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  depends,
  files: [`src/${id}.ts`],
  proof: `${id}.spec.ts`,
  status: 'waiting',
});

const requirements = `${JSON.stringify({
  prompt: 'Ship the field\n',
  tickets: [{ key: KEY, summary: 'Ship the field' }],
  plan: { name: 'plan', overview: '', items: ['do it'], decision: 'approve' },
})}\n`;

const tasksOf = async (app: TestApp) =>
  parseSubtasks(await app.app.get(DocumentRepository).latestBody(KEY, 'subtasks'));

const statuses = async (app: TestApp) => Object.fromEntries((await tasksOf(app)).map((item) => [item.id, item.status]));

/** The subtask run ends in `status`; a `done` one has a merge request with green CI. */
async function end(app: TestApp, id: string, status: 'done' | 'blocked', iid = 0): Promise<void> {
  const runs = app.app.get(RunRepository);
  const run = (await runs.findRun(`${KEY}-${id}`))!;
  if (status === 'done') {
    const documents = app.app.get(DocumentRepository);
    await documents.putDocument(run, 'requirements', requirements);
    await documents.putDocument(run, 'repos', 'demo\n');
    const record = { project: 'demo', iid, url: `https://code.example/demo/${iid}`, draft: false, summary: '' };
    await documents.putDocument(run, 'merge_request', renderMergeRequest([record]));
    writeRunState(run, { status: 'done', currentStep: 'done' });
  } else {
    writeRunState(run, {
      status: 'blocked',
      currentStep: 'research',
      reason: { code: 'LOOP_LIMIT', message: 'checks ran 3 times (MAX_RETURNS); Resume starts another round' },
    });
  }
  await runs.saveRun(run);
}

describe('one blocked task holds only its dependents', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  beforeEach(async () => {
    flow = await createFlowHarness(KEY);
    const runs = flow.app.app.get(RunRepository);
    const documents = flow.app.app.get(DocumentRepository);
    const parent = await save(runs, KEY, 'implement', 'waiting');
    parent.split = true;
    parent.projects = 'demo\n';
    await runs.saveRun(parent);
    await documents.putDocument(parent, 'requirements', requirements);
    await documents.putDocument(parent, 'repos', 'demo\n');
    const tasks = [task('a'), task('b', ['a']), task('c'), task('d'), task('e')];
    await documents.putDocument(parent, 'subtasks', `${JSON.stringify(tasks)}\n`);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  it('merges a green task, starts an independent one, names the blocked task, and ends done after a fix', async () => {
    const { app } = flow;
    await app.pipeline.step('implement', KEY);
    expect(await statuses(app)).toEqual({ a: 'running', b: 'waiting', c: 'running', d: 'running', e: 'waiting' });

    await end(app, 'a', 'blocked');
    await end(app, 'c', 'done', 1);
    await app.pipeline.step('implement', KEY);
    await assertInvariants(app);

    expect(await statuses(app)).toEqual({ a: 'blocked', b: 'waiting', c: 'merged', d: 'running', e: 'running' });
    const state = deriveState((await app.app.get(RunRepository).findRun(KEY))!);
    expect(state.state).toBe('waiting');
    expect(state.reason?.message).toContain('subtask a is blocked; Resume, Replay or Skip task clears it');
    expect((await tasksOf(app))[1]?.note).toBe('waiting for a, which is blocked');

    await end(app, 'a', 'done', 2);
    await end(app, 'd', 'done', 3);
    await end(app, 'e', 'done', 4);
    await app.pipeline.step('implement', KEY);
    await end(app, 'b', 'done', 5);
    await app.pipeline.step('implement', KEY);

    expect(await statuses(app)).toEqual({ a: 'merged', b: 'merged', c: 'merged', d: 'merged', e: 'merged' });
    expect((await app.app.get(RunRepository).findRun(KEY))?.currentStep).toBe('checks');
  });

  it('Resume of the blocked task runs a parent pass at once, and a green sibling merges in it', async () => {
    const { app } = flow;
    const runs = app.app.get(RunRepository);
    const parent = (await runs.findRun(KEY))!;
    await app.app
      .get(DocumentRepository)
      .putDocument(parent, 'subtasks', `${JSON.stringify([task('a'), task('c')])}\n`);
    await app.pipeline.step('implement', KEY);
    await end(app, 'a', 'blocked');
    await app.pipeline.step('implement', KEY);
    expect(deriveState((await runs.findRun(KEY))!).state).toBe('waiting');
    await end(app, 'c', 'done', 1);
    await app.pipeline.step('implement', KEY);
    expect(deriveState((await runs.findRun(KEY))!).state).toBe('blocked');

    let during: Record<string, string> = {};
    installScripts(
      app,
      {
        research: async () => {
          await app.app.get(CommandService).idle();
          await app.pipeline.whenIdle(KEY);
          during = await statuses(app);
          return { outcome: 'waiting', exitCode: 0 };
        },
      },
      ['research'],
    );
    await app.pipeline.runThrough(`${KEY}-a`);

    expect(during.c).toBe('merged');
    expect(during.a).toBe('running');
  });

  it('Skip closes a blocked task for good: its dependents go on and no command on it is accepted', async () => {
    const { app } = flow;
    const runs = app.app.get(RunRepository);
    const parent = (await runs.findRun(KEY))!;
    await app.app
      .get(DocumentRepository)
      .putDocument(parent, 'subtasks', `${JSON.stringify([task('a'), task('b', ['a'])])}\n`);
    await app.pipeline.step('implement', KEY);
    await end(app, 'a', 'blocked');
    await app.pipeline.step('implement', KEY);
    await assertInvariants(app);
    expect((await statuses(app)).b).toBe('waiting');

    await app.app.get(CommandService).submit('skip', KEY, { taskId: 'a' });
    await app.app.get(CommandService).idle();
    await app.pipeline.whenIdle(KEY);
    await app.pipeline.step('implement', KEY);
    await assertInvariants(app);

    expect((await statuses(app)).a).toBe('skipped');
    expect((await statuses(app)).b).toBe('running');
    const child = (await runs.findRun(`${KEY}-a`))!;
    expect(deriveState(child).state).toBe('skipped');
    await expect(app.app.get(CommandService).submit('resume', child.key, {})).rejects.toThrow('this task was skipped');
    await expect(app.app.get(CommandService).submit('rebase', child.key, {})).rejects.toThrow('this task was skipped');
  });

  /** A subtask run in `checks` whose process died: running, with an attempt nobody owns. Returns the attempt id. */
  async function cutInChecks(id: string): Promise<string> {
    const run = await flow.app.app.get(RunRepository).begin(`${KEY}-${id}`, 'checks');
    // A task run that reached checks has the inputs its steps read.
    const documents = flow.app.app.get(DocumentRepository);
    await documents.putDocument(run, 'requirements', requirements);
    await documents.putDocument(run, 'repos', 'demo\n');
    return run.activeAttempt!;
  }

  const queries = () => flow.app.app.get(RunQueriesService);
  const checksVisits = async (id: string) => (await queries().step(`${KEY}-${id}`, 'checks')).visits;
  const subtaskView = async (id: string) => queries().flow(`${KEY}-${id}`);
  const layerRun = async (id: string) =>
    (await queries().flow(KEY)).tasks?.flatMap((layer) => layer.tasks).find((item) => item.id === id)?.run;
  const launches = (id: string) => flow.launched.filter((key) => key === `${KEY}-${id}`).length;
  const clock = (iso: string) => iso.slice(11, 16);

  async function startTasks(): Promise<void> {
    const runs = flow.app.app.get(RunRepository);
    const parent = (await runs.findRun(KEY))!;
    await flow.app.app
      .get(DocumentRepository)
      .putDocument(parent, 'subtasks', `${JSON.stringify([task('a'), task('c')])}\n`);
    await flow.app.pipeline.step('implement', KEY);
    await end(flow.app, 'c', 'done', 1);
  }

  /** Nothing the parent or the subtask shows reads blocked or failed, or offers Resume or Skip (a running run keeps its Replay, as always). */
  async function expectNotBlocked(): Promise<void> {
    const state = deriveState((await flow.app.app.get(RunRepository).findRun(KEY))!);
    expect(['blocked', 'failed']).not.toContain(state.state);
    const sentence = (await queries().flow(KEY)).taskLine ?? '';
    for (const text of [state.reason?.message ?? '', sentence]) {
      expect(text).not.toContain('subtask a is blocked');
      expect(text).not.toContain('Resume, Replay or Skip');
    }
    expect(['blocked', 'failed']).not.toContain((await statuses(flow.app)).a);
    expect(['blocked', 'failed']).not.toContain((await layerRun('a'))?.state);
    const own = await subtaskView('a');
    expect(['blocked', 'failed']).not.toContain(own.state);
    for (const action of ['resume', 'skip']) expect(own.actions as string[]).not.toContain(action);
  }

  it("a restart in a subtask's checks relaunches it without the parent naming it blocked, and the run ends done", async () => {
    await startTasks();
    const cut = await cutInChecks('a');
    const before = launches('a');
    const seen: { note?: InterruptionNote; visits: Awaited<ReturnType<typeof checksVisits>> } = { visits: [] };

    // The startup pass relaunches the cut step before the harness wires its hold. Every subtask start waits for the
    // test to open the gate, so the scripted steps are in place before the relaunched step looks for its class.
    let open!: () => void;
    const starts: Promise<unknown>[] = [];
    const gate = new Promise<void>((resolve) => (open = resolve));
    const start = Reflect.get<PipelineService, 'startDetached'>(PipelineService.prototype, 'startDetached');
    const held = function (
      this: PipelineService,
      key: string,
      ...rest: Parameters<PipelineService['startDetached']> extends [string, ...infer R] ? R : never
    ) {
      if (key === KEY) return start.call(this, key, ...rest);
      flow.launched.push(key);
      const started = gate.then(() => start.call(this, key, ...rest));
      starts.push(started);
      return started;
    };
    jest.spyOn(PipelineService.prototype, 'startDetached').mockImplementation(held);

    await flow.restart();
    jest.spyOn(flow.app.pipeline, 'startDetached').mockImplementation(held);
    installScripts(
      flow.app,
      {
        checks: async () => {
          // The relaunched attempt is running: the cut one is the latest stored visit.
          await expectNotBlocked();
          seen.note = (await layerRun('a'))?.interruption;
          seen.visits = await checksVisits('a');
          return { outcome: 'ok', exitCode: 0 };
        },
      },
      ['checks', 'code-review', 'merge-request', 'pipeline'],
    );
    open();
    await flow.tick();
    await flow.app.app.get(CommandService).idle();
    await Promise.all(starts);
    await flow.app.pipeline.whenIdle(`${KEY}-a`);
    await flow.app.pipeline.whenIdle(KEY);

    const { note, visits } = seen;
    expect(launches('a')).toBe(before + 1);
    expect(note).toMatchObject({ relaunched: true });
    expect(visits).toHaveLength(2);
    expect(visits[1]).toMatchObject({ status: 'running', attempt: visits[0].attempt + 1 });
    expect(visits[0]).toMatchObject({ attemptId: cut, killReason: 'process died', interruption: note });
    expect(interruptionSentence(note!, clock)).toBe(
      `Interrupted at ${clock(note!.at)} by a server restart. The server starts this step again by itself. Nothing to do.`,
    );
    const after = await checksVisits('a');
    expect(after[0]).toMatchObject({ attemptId: cut, killReason: 'process died', interruption: note });
    expect(after.length).toBeGreaterThan(1);
    expect(after[1]?.killReason).not.toBe('process died');

    // The scripted steps leave no merge request: the subtask ends green as a real one does.
    await end(flow.app, 'a', 'done', 2);
    await flow.app.pipeline.step('implement', KEY);
    await expectNotBlocked();
    installScripts(flow.app, {}, ['checks', 'code-review', 'merge-request', 'pipeline']);
    await flow.app.pipeline.runThrough(KEY);

    expect(await statuses(flow.app)).toEqual({ a: 'merged', c: 'merged' });
    expect((await flow.app.app.get(RunRepository).findRun(KEY))?.currentStep).toBe('done');
    await assertInvariants(flow.app);
  });

  it('with MAX_LAUNCHES reached the same restart leaves the subtask failed and the parent shows it blocked', async () => {
    await startTasks();
    for (let earlier = 0; earlier < 2; earlier++) {
      const runs = flow.app.app.get(RunRepository);
      const run = await runs.begin(`${KEY}-a`, 'checks');
      const attempt = run.activeAttempt;
      writeRunState(run, { status: 'failed', ownerPid: null });
      await flow.app.app.get(VisitRepository).finalize(attempt, run, { ...visit('checks', 'failed'), exitCode: 1 });
    }
    const cut = await cutInChecks('a');
    const before = launches('a');

    await flow.restart();
    await flow.tick();
    await flow.app.app.get(CommandService).idle();
    await flow.app.pipeline.whenIdle(KEY);

    const runs = flow.app.app.get(RunRepository);
    const child = (await runs.findRun(`${KEY}-a`))!;
    expect(child.status).toBe('failed');
    expect((await subtaskView('a')).actions).toContain('resume');
    const commands = await flow.app.app.get(CommandRepository).listForRun(child.id);
    expect(commands.filter((command) => command.idempotencyKey?.startsWith('relaunch-'))).toEqual([]);
    expect(launches('a')).toBe(before);
    const visits = await checksVisits('a');
    const dead = visits.find((item) => item.attemptId === cut);
    expect(dead).toMatchObject({
      killReason: 'process died',
      interruption: { relaunched: false, cause: 'limit', limit: 3 },
    });
    expect(interruptionSentence(dead!.interruption!, clock)).toBe(
      `Interrupted at ${clock(dead!.interruption!.at)} by a server restart. Not started again: the launch limit of 3 was reached. Resume, Replay or Skip.`,
    );

    await flow.app.pipeline.step('implement', KEY);
    expect((await statuses(flow.app)).a).toBe('blocked');
    const parent = deriveState((await runs.findRun(KEY))!);
    expect(parent.reason?.message).toContain('subtask a is blocked');
    expect(parent.reason?.message).toContain('Resume, Replay or Skip task clears it');
  });
});
