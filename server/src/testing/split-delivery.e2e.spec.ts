import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { CommandService } from '../pipeline/command.service';
import { Reconciler } from '../pipeline/reconciler';
import { parseSubtasks, type Subtask } from '../contract/subtask';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { StepEventLog } from '../history/step-event.log';
import { VisitRepository } from '../history/visit.repository';
import { deriveState, writeRunState } from '../history/run-state';
import { branchName, summaryForBranch } from '../steps/branch/branch-name';
import { SubtaskOps } from '../steps/shared/subtask-ops';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { RunQueriesService } from '../api/run-queries.service';
import { git, save } from './runs.spec-helpers';
import { createFlowHarness, useGitlabOrigin } from './flow-harness';
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

async function world(
  tasks: Subtask[] = [task('a'), task('b'), task('c', ['a'])],
  blocks?: BlockAgentRunner,
  options: Parameters<typeof createFlowHarness>[1] = {},
) {
  const flow = await createFlowHarness(KEY, { blocks, ...options });
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
    const byId = Object.fromEntries((flow.tasks ?? []).map((item) => [item.id, item]));
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
    const byId = Object.fromEntries((flow.tasks ?? []).map((item) => [item.id, item]));
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

  it('goes on by itself when the pass that merged the last task failed right after the merge', async () => {
    const built = await world([task('a')], undefined, { realHost: true, taskWorktrees: true });
    app = built.app;
    const feature = `feature/${KEY}-ship-the-field`;
    const clone = join(app.root, 'demo');
    await app.pipeline.step('implement', KEY);
    // The task branch is cut from the feature branch, gets a commit, is pushed and has a merge request.
    const child = (await app.app.get(RunRepository).findRun(`${KEY}-a`))!;
    const branch = branchName(child.key, summaryForBranch(requirements, child.key));
    const tree = join(app.root, 'worktrees', child.key, 'demo');
    mkdirSync(join(tree, '..'), { recursive: true });
    git(clone, ['fetch', 'origin']);
    git(clone, ['worktree', 'add', '-b', branch, tree, `origin/${feature}`]);
    mkdirSync(join(tree, 'src'), { recursive: true });
    writeFileSync(join(tree, 'src', 'a.ts'), 'export const a = 1;\n');
    git(tree, ['add', 'src/a.ts']);
    git(tree, ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', 'commit', '-m', 'feat: a']);
    git(tree, ['push', 'origin', branch]);
    built.host.ci.pass(git(tree, ['rev-parse', 'HEAD']));
    const { record } = await built.host.openMergeRequest({
      project: 'demo',
      source: branch,
      target: feature,
      title: 'a',
      summary: '',
      draft: false,
    });
    const documents = app.app.get(DocumentRepository);
    await documents.putDocument(child, 'requirements', requirements);
    await documents.putDocument(child, 'repos', 'demo\n');
    await documents.putDocument(child, 'merge_request', renderMergeRequest([record]));
    writeRunState(child, { status: 'done', currentStep: 'done' });
    await app.app.get(RunRepository).saveRun(child);
    const parent = (await parentRun(app))!;
    parent.codeHost = 'gitlab';
    await app.app.get(RunRepository).saveRun(parent);
    jest.spyOn(app.app.get(SubtaskOps), 'fastForward').mockRejectedValueOnce(new Error('git merge --ff-only failed'));

    for (let tick = 0; tick < 5; tick++) {
      await app.app.get(Reconciler).resumeSubtaskParents();
      await settle(app);
    }

    expect(await statuses(app)).toEqual({ a: 'merged' });
    expect(deriveState((await app.app.get(RunRepository).findRun(`${KEY}-a`))!).state).toBe('merged');
    expect((await parentRun(app))?.currentStep).not.toBe('implement');
    const improve = (await app.app.get(RunQueriesService).flow(KEY)).phases
      .flatMap((phase) => phase.steps)
      .find((step) => step.name === 'implement-improve');
    expect(improve).toMatchObject({ status: 'skipped' });
    expect(git(join(app.root, 'worktrees', KEY, 'demo'), ['rev-parse', 'HEAD'])).toBe(
      git(join(app.root, 'demo.git'), ['rev-parse', `refs/heads/feature/${KEY}-ship-the-field`]),
    );
    await assertInvariants(app);
  });

  /**
   * A parent whose last pass merged task a and failed before its worktree followed: the worktree is behind the feature
   * branch on origin, where task a changed line 1 of src/shared.ts. The edits are written by `edit` into that worktree.
   */
  async function behindWithEdits(edit: (shared: string, tree: string) => void) {
    const built = await world([task('a')], undefined, { realHost: true, taskWorktrees: true });
    app = built.app;
    const feature = `feature/${KEY}-ship-the-field`;
    const clone = join(app.root, 'demo');
    const bare = join(app.root, 'demo.git');
    const parentTree = join(app.root, 'worktrees', KEY, 'demo');
    const shared = join(parentTree, 'src', 'shared.ts');
    mkdirSync(join(parentTree, 'src'), { recursive: true });
    writeFileSync(shared, lines('one'));
    git(parentTree, ['add', 'src/shared.ts']);
    git(parentTree, ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', 'commit', '-m', 'feat: shared']);
    git(parentTree, ['push', 'origin', feature]);
    await app.pipeline.step('implement', KEY);
    const child = (await app.app.get(RunRepository).findRun(`${KEY}-a`))!;
    const branch = branchName(child.key, summaryForBranch(requirements, child.key));
    const tree = join(app.root, 'worktrees', child.key, 'demo');
    mkdirSync(join(tree, '..'), { recursive: true });
    git(clone, ['fetch', 'origin']);
    git(clone, ['worktree', 'add', '-b', branch, tree, `origin/${feature}`]);
    writeFileSync(join(tree, 'src', 'shared.ts'), lines('task one'));
    writeFileSync(join(tree, 'src', 'a.ts'), 'export const a = 1;\n');
    git(tree, ['add', 'src']);
    git(tree, ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', 'commit', '-m', 'feat: a']);
    git(tree, ['push', 'origin', branch]);
    built.host.ci.pass(git(tree, ['rev-parse', 'HEAD']));
    const { record } = await built.host.openMergeRequest({
      project: 'demo',
      source: branch,
      target: feature,
      title: 'a',
      summary: '',
      draft: false,
    });
    const documents = app.app.get(DocumentRepository);
    await documents.putDocument(child, 'requirements', requirements);
    await documents.putDocument(child, 'repos', 'demo\n');
    await documents.putDocument(child, 'merge_request', renderMergeRequest([record]));
    writeRunState(child, { status: 'done', currentStep: 'done' });
    await app.app.get(RunRepository).saveRun(child);
    const parent = (await parentRun(app))!;
    parent.codeHost = 'gitlab';
    await app.app.get(RunRepository).saveRun(parent);
    const originHead = () => git(bare, ['rev-parse', `refs/heads/${feature}`]);
    const heads: { worktree: string; origin: string }[] = [];
    // The pass that merged a fails once, as f98's did, with the worktree behind the feature branch and edits in it.
    jest.spyOn(app.app.get(SubtaskOps), 'fastForward').mockImplementationOnce(() => {
      heads.push({ worktree: git(parentTree, ['rev-parse', 'HEAD']), origin: originHead() });
      edit(shared, parentTree);
      return Promise.reject(new Error('git merge --ff-only failed'));
    });
    const tick = async () => {
      await app.app.get(Reconciler).resumeSubtaskParents();
      await settle(app);
    };
    await tick();
    expect(heads[0]?.worktree).not.toBe(originHead());
    return {
      parentTree,
      shared,
      bare,
      feature,
      originHead,
      before: heads[0]?.origin ?? '',
      tick,
      worktreeHead: heads[0]?.worktree ?? '',
    };
  }

  const lines = (first: string, fifth = 'five') => [first, 'two', 'three', 'four', fifth, ''].join('\n');

  it("commits the parent's own edits to other lines, brings the feature branch and goes on with no person", async () => {
    const { parentTree, bare, feature, originHead, before, tick } = await behindWithEdits((shared, tree) => {
      writeFileSync(shared, lines('one', 'own five'));
      writeFileSync(join(tree, 'src', 'own.ts'), 'own\n');
    });

    for (let count = 0; count < 5; count++) await tick();

    const events = (await app.app.get(StepEventLog).page((await parentRun(app))!.id, { limit: 2000 })).events;
    const summaries = events
      .filter((event) => event.step === 'implement' && 'summary' in event)
      .map((e) => String((e as { summary?: string }).summary));
    expect(summaries.join('\n')).toContain('src/shared.ts, src/own.ts');
    expect(await statuses(app)).toEqual({ a: 'merged' });
    expect((await parentRun(app))?.currentStep).not.toBe('implement');
    expect(deriveState((await parentRun(app))!).state).not.toBe('blocked');
    expect(git(bare, ['show', `refs/heads/${feature}:src/shared.ts`])).toBe(lines('task one', 'own five').trimEnd());
    expect(git(bare, ['show', `refs/heads/${feature}:src/own.ts`])).toBe('own');
    expect(git(parentTree, ['status', '--porcelain'])).toBe('');
    expect(git(parentTree, ['rev-parse', 'HEAD'])).toBe(originHead());
    expect(originHead()).not.toBe(before);
    await assertInvariants(app);
  });

  it("blocks with PARENT_TREE_CONFLICT naming the file when the parent's edits touch the lines a merged task changed", async () => {
    const { parentTree, originHead, before, tick, worktreeHead } = await behindWithEdits((shared) =>
      writeFileSync(shared, lines('own one')),
    );

    for (let count = 0; count < 3; count++) await tick();

    const parent = (await parentRun(app))!;
    const { state, reason } = deriveState(parent);
    expect(state).toBe('blocked');
    expect(reason?.code).toBe('PARENT_TREE_CONFLICT');
    expect(reason?.message).toContain('src/shared.ts');
    expect(reason?.message).toContain(before);
    expect(reason?.message).toContain(worktreeHead);
    expect(reason?.message).not.toContain('merge --ff-only');
    expect(git(parentTree, ['status', '--porcelain'])).toContain('src/shared.ts');
    expect(originHead()).toBe(before);
    await assertInvariants(app);
  });

  it('goes on after Resume once the person resolved the conflicting file', async () => {
    const { parentTree, shared, bare, feature, tick } = await behindWithEdits((file) =>
      writeFileSync(file, lines('own one')),
    );
    expect(deriveState((await parentRun(app))!).reason?.code).toBe('PARENT_TREE_CONFLICT');

    writeFileSync(shared, lines('task one', 'own five'));
    await app.app.get(CommandService).accept('resume', KEY, {});
    await settle(app);
    await tick();

    expect((await parentRun(app))?.currentStep).not.toBe('implement');
    expect(git(bare, ['show', `refs/heads/${feature}:src/shared.ts`])).toBe(lines('task one', 'own five').trimEnd());
    expect(git(parentTree, ['status', '--porcelain'])).toBe('');
  });

  it('waits for the CI of a head a subtask merge moved and returns to implement on its red', async () => {
    const built = await world([task('a'), task('b')], undefined, { realHost: true, realSteps: ['commit'] });
    app = built.app;
    const feature = `feature/${KEY}-ship-the-field`;
    const bare = join(app.root, 'demo.git');
    const headOnOrigin = () => git(bare, ['rev-parse', `refs/heads/${feature}`]);

    await app.pipeline.step('implement', KEY);
    await finish(app, 'a', 1);
    await app.pipeline.step('implement', KEY);
    // An earlier commit pass published the head after a, and its CI is green.
    const older = headOnOrigin();
    const documents = app.app.get(DocumentRepository);
    await documents.putDocument(
      (await parentRun(app))!,
      'pipeline_ref',
      `project: group/demo\nref: ${feature}\nsha: ${older}\n`,
    );
    built.host.ci.pass(older);
    await finish(app, 'b', 2);
    await app.pipeline.step('implement', KEY);
    const head = headOnOrigin();
    expect(head).not.toBe(older);
    built.host.ci.fail(head, 'lint: runShell complexity 25 over its baseline 24\n');
    useGitlabOrigin(app.root, built.tree);
    const gitlab = (await parentRun(app))!;
    gitlab.codeHost = 'gitlab';
    await app.app.get(RunRepository).saveRun(gitlab);

    for (const step of ['checks', 'code-review', 'commit', 'merge-request'] as const) {
      await app.pipeline.step(step, KEY);
    }
    expect(headOnOrigin()).toBe(head);
    expect(await documents.latestBody(KEY, 'pipeline_ref')).toContain(`sha: ${head}`);
    await app.pipeline.step('pipeline', KEY);

    const parent = (await parentRun(app))!;
    expect(parent.currentStep).toBe('implement');
    expect(await documents.latestBody(KEY, 'pipeline_log')).toContain('complexity 25');
    expect(await documents.latestBody(KEY, 'return')).toContain('complexity 25');
    expect((await documents.latestBody(KEY, 'merge_request')) ?? '').not.toContain('Ready to merge');
    expect((await documents.latestBody(KEY, 'pipeline_log')) ?? '').not.toContain('Ready to merge');
  });
});
