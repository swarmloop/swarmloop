import 'reflect-metadata';
import { CommandService } from '../pipeline/command.service';
import { Reconciler } from '../pipeline/reconciler';
import { parseSubtasks, type Subtask } from '../contract/subtask';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { deriveState, writeRunState } from '../history/run-state';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { RunQueriesService } from '../api/run-queries.service';
import { save } from './runs.spec-helpers';
import { createFlowHarness } from './flow-harness';
import { BlockAgentRunner } from './result-answer';
import { assertInvariants } from './flow-invariants';
import type { TestApp } from './test-app';

const KEY = 'PROJ-400';

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

async function world(tasks: Subtask[] = [task('a'), task('b'), task('c', ['a'])], blocks?: BlockAgentRunner) {
  const flow = await createFlowHarness(KEY, { blocks });
  const app = flow.app;
  const runs = app.app.get(RunRepository);
  const documents = app.app.get(DocumentRepository);
  const parent = await save(runs, KEY, 'implement', 'waiting');
  parent.split = true;
  parent.projects = 'demo\n';
  await runs.saveRun(parent);
  await documents.putDocument(parent, 'requirements', requirements);
  await documents.putDocument(parent, 'repos', 'demo\n');
  await documents.putDocument(parent, 'contract', 'decisions:\n- subtask a: store UTC\n');
  await documents.putDocument(parent, 'subtasks', `${JSON.stringify(tasks)}\n`);
  return { app, tree: flow.tree, host: flow.host, launched: flow.launched };
}

const tasksOf = async (app: TestApp) =>
  parseSubtasks(await app.app.get(DocumentRepository).latestBody(KEY, 'subtasks'));

const statuses = async (app: TestApp) => Object.fromEntries((await tasksOf(app)).map((item) => [item.id, item.status]));

const parentRun = (app: TestApp) => app.app.get(RunRepository).findRun(KEY);

/** The subtask run ends and has a merge request with green CI, which the next pass merges. */
async function finish(app: TestApp, id: string, iid: number): Promise<void> {
  const run = (await app.app.get(RunRepository).findRun(`${KEY}-${id}`))!;
  const documents = app.app.get(DocumentRepository);
  await documents.putDocument(run, 'requirements', requirements);
  await documents.putDocument(run, 'repos', 'demo\n');
  const record = { project: 'demo', iid, url: `https://code.example/demo/${iid}`, draft: false, summary: '' };
  await documents.putDocument(run, 'merge_request', renderMergeRequest([record]));
  writeRunState(run, { status: 'done', currentStep: 'done' });
  await app.app.get(RunRepository).saveRun(run);
}

async function settle(app: TestApp): Promise<void> {
  await app.app.get(CommandService).idle();
  await app.pipeline.whenIdle(KEY);
}

/** Every task of the split run is merged: a, b and c, one after the other as their dependencies allow. */
async function mergeAll(app: TestApp): Promise<void> {
  await app.pipeline.step('implement', KEY);
  await finish(app, 'a', 1);
  await finish(app, 'b', 2);
  await app.pipeline.step('implement', KEY);
  expect(await statuses(app)).toEqual({ a: 'merged', b: 'merged', c: 'running' });
  expect((await parentRun(app))?.currentStep).toBe('implement');
  await finish(app, 'c', 3);
  await app.pipeline.step('implement', KEY);
}

describe('a split run is reviewed and delivered as one merge request', () => {
  let app: TestApp;

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  it('merges 3 tasks, goes through review, takes a return to the agent on the feature branch, and ends done', async () => {
    const blocks = new BlockAgentRunner({
      implement: [{ block: { implementation: ['added the field'], summary: ['the field is there'] } }],
    });
    const built = await world(undefined, blocks);
    app = built.app;

    await mergeAll(app);

    expect(await statuses(app)).toEqual({ a: 'merged', b: 'merged', c: 'merged' });
    expect((await parentRun(app))?.currentStep).toBe('checks');
    const flow = await app.app.get(RunQueriesService).flow(KEY);
    expect(flow.taskLine).toBe('Split: 3 tasks · 3 merged');
    expect(flow.decisions).toBe('- subtask a: store UTC');
    const improve = flow.phases.flatMap((phase) => phase.steps).find((step) => step.name === 'implement-improve');
    expect(improve).toMatchObject({ status: 'skipped', note: 'each task checked its own work' });

    await app.pipeline.step('checks', KEY);
    await app.pipeline.step('code-review', KEY);
    // The review returned the change: the agent fixes it on the merged feature branch.
    const run = (await parentRun(app))!;
    await app.app.get(DocumentRepository).putDocument(run, 'return', '## requirements\nthe field is missing\n');
    run.currentStep = 'implement';
    await app.app.get(RunRepository).saveRun(run);
    await app.pipeline.step('implement', KEY);

    expect((await parentRun(app))?.currentStep).toBe('implement-improve');
    const prompts = blocks.prompts.filter((launch) => launch.step === 'implement').map((launch) => launch.prompt);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('the field is missing');
    expect(prompts[0]).toContain('decisions:\n- subtask a: store UTC');
    expect(prompts[0]).toContain('- Task b\n  changed: Do b.');
    expect(blocks.steps).toContain('code-review-report');
    await app.pipeline.step('implement-improve', KEY);
    expect((await parentRun(app))?.currentStep).toBe('checks');
    for (const step of ['checks', 'code-review', 'commit', 'merge-request', 'pipeline'] as const) {
      await app.pipeline.step(step, KEY);
    }
    const done = (await parentRun(app))!;
    expect(done.currentStep).toBe('done');
    await assertInvariants(app);
    expect(await statuses(app)).toEqual({ a: 'merged', b: 'merged', c: 'merged' });
  });

  it('shows the open tasks and their own runs on the parent page while a task is open', async () => {
    const built = await world();
    app = built.app;
    await app.pipeline.step('implement', KEY);
    await finish(app, 'a', 1);
    await finish(app, 'b', 2);

    await app.pipeline.step('implement', KEY);

    const flow = await app.app.get(RunQueriesService).flow(KEY);
    expect(flow.currentStep).toBe('implement');
    expect(flow.taskLine).toBe('Split: 3 tasks · 2 merged · 1 running');
    const byId = Object.fromEntries((flow.tasks ?? []).flatMap((layer) => layer.tasks).map((item) => [item.id, item]));
    expect(byId.c?.run?.key).toBe(`${KEY}-c`);
    expect(byId.a?.run?.currentStep).toBe('done');
  });

  it('records the merge on the task run in the same pass that merges it', async () => {
    const built = await world();
    app = built.app;
    await app.pipeline.step('implement', KEY);
    await finish(app, 'a', 1);
    await finish(app, 'b', 2);

    await app.pipeline.step('implement', KEY);

    for (const id of ['a', 'b']) {
      const child = (await app.app.get(RunRepository).findRun(`${KEY}-${id}`))!;
      expect(deriveState(child).state).toBe('merged');
      expect(child.mergeOutcome).toContain('"sha"');
    }
    const flow = await app.app.get(RunQueriesService).flow(KEY);
    const byId = Object.fromEntries((flow.tasks ?? []).flatMap((layer) => layer.tasks).map((item) => [item.id, item]));
    expect(byId.a?.run?.state).toBe('merged');
  });

  it('stops in the middle, and Resume goes on to merge every task', async () => {
    const built = await world();
    app = built.app;
    await app.pipeline.step('implement', KEY);
    for (const id of ['a', 'b']) {
      const run = (await app.app.get(RunRepository).findRun(`${KEY}-${id}`))!;
      writeRunState(run, { status: 'running', currentStep: 'research', ownerPid: process.pid });
      await app.app.get(RunRepository).saveRun(run);
    }

    await app.app.get(CommandService).submit('stop', KEY, {});

    expect(deriveState((await parentRun(app))!).state).toBe('stopped');
    await app.app.get(Reconciler).resumeSubtaskParents();
    await settle(app);
    expect(built.launched).toEqual([`${KEY}-a`, `${KEY}-b`]);

    await app.app.get(CommandService).submit('resume', KEY, {});
    await settle(app);
    expect(built.launched).toEqual([`${KEY}-a`, `${KEY}-b`, `${KEY}-a`, `${KEY}-b`]);

    await finish(app, 'a', 1);
    await finish(app, 'b', 2);
    await app.pipeline.step('implement', KEY);
    await finish(app, 'c', 3);
    await app.pipeline.step('implement', KEY);

    expect(await statuses(app)).toEqual({ a: 'merged', b: 'merged', c: 'merged' });
    expect((await parentRun(app))?.currentStep).toBe('checks');
  });

  it('gets at most one pass per subtask change plus one over 10 reconciler ticks, and ends done', async () => {
    const built = await world();
    app = built.app;
    const ticks = async () => {
      for (let tick = 0; tick < 10; tick++) {
        await app.app.get(Reconciler).resumeSubtaskParents();
        await settle(app);
      }
    };

    await app.pipeline.step('implement', KEY);
    await ticks();
    await finish(app, 'a', 1);
    await finish(app, 'b', 2);
    await app.pipeline.step('implement', KEY);
    await ticks();
    await finish(app, 'c', 3);
    await app.pipeline.step('implement', KEY);
    await ticks();

    expect(await statuses(app)).toEqual({ a: 'merged', b: 'merged', c: 'merged' });
    expect((await parentRun(app))?.currentStep).toBe('checks');
    const visits = await app.app.get(VisitRepository).listStats((await parentRun(app))!.id);
    expect(visits.filter((visit) => visit.step === 'implement').length).toBeLessThanOrEqual(3 + 1);
  });

  it('splits into two subtasks, merges both and ends the parent done', async () => {
    const built = await world([task('a'), task('b', ['a'])]);
    app = built.app;

    await app.pipeline.step('implement', KEY);
    await finish(app, 'a', 1);
    await app.pipeline.step('implement', KEY);
    expect(await statuses(app)).toEqual({ a: 'merged', b: 'running' });
    await finish(app, 'b', 2);
    await app.pipeline.step('implement', KEY);

    expect(await statuses(app)).toEqual({ a: 'merged', b: 'merged' });
    expect((await parentRun(app))?.currentStep).toBe('checks');
    expect((await app.app.get(RunQueriesService).flow(KEY)).taskLine).toBe('Split: 2 tasks · 2 merged');
    for (const step of ['checks', 'code-review', 'commit', 'merge-request', 'pipeline'] as const) {
      await app.pipeline.step(step, KEY);
    }
    expect((await parentRun(app))?.currentStep).toBe('done');
    await assertInvariants(app);
  });
});
