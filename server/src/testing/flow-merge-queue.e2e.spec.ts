import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { parseSubtasks, type Subtask } from '../contract/subtask';
import { ConflictException } from '@nestjs/common';
import { RunRebaseService } from '../api/run-rebase.service';
import { FlowRepository } from '../history/flow.repository';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { writeRunState } from '../history/run-state';
import { CommandService } from '../pipeline/command.service';
import { SubtaskPort } from '../pipeline/subtask-port';
import { branchName, summaryForBranch } from '../steps/branch/branch-name';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { RunRebase } from '../steps/run-rebase';
import { createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { git, save } from './runs.spec-helpers';

const KEY = 'PROJ-470';
const FEATURE = `feature/${KEY}-ship-the-field`;

const task = (id: string, files = [`src/${id}.ts`]): Subtask => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  depends: [],
  files,
  proof: `${id}.spec.ts`,
  status: 'waiting',
});

const requirements = `${JSON.stringify({
  prompt: 'Ship the field\n',
  tickets: [{ key: KEY, summary: 'Ship the field' }],
  plan: { name: 'plan', overview: '', items: ['do it'], decision: 'approve' },
})}\n`;

describe('the feature branch stays green: every merge is of a task tested on top', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  /** The rebase commands the parent sent, by run key: the idempotency key and the payload. */
  let rebases: { key: string; payload: Record<string, unknown>; idempotencyKey?: string }[];
  /** When set, the Rebase command the parent sends runs for real on the worktree of the task. */
  let realRebases = false;

  beforeEach(async () => {
    flow = await createFlowHarness(KEY);
    rebases = [];
    realRebases = false;
    const commands = flow.app.app.get(CommandService);
    const accept = commands.accept.bind(commands);
    jest.spyOn(commands, 'accept').mockImplementation((type, key, payload, options) => {
      if (type !== 'rebase') return accept(type, key, payload, options);
      // The command door runs a repeat of one idempotency key once.
      if (!rebases.some((sent) => sent.idempotencyKey === options?.idempotencyKey)) {
        rebases.push({ key, payload, idempotencyKey: options?.idempotencyKey });
      }
      return realRebases ? accept(type, key, payload, options) : (Promise.resolve({}) as ReturnType<typeof accept>);
    });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const runs = () => flow.app.app.get(RunRepository);
  const documents = () => flow.app.app.get(DocumentRepository);
  const clone = () => join(flow.app.root, 'demo');
  const treeOf = (id: string) => join(flow.app.root, 'worktrees', `${KEY}-${id}`, 'demo');
  const tasks = async () => parseSubtasks(await documents().latestBody(KEY, 'subtasks'));
  const statuses = async () => Object.fromEntries((await tasks()).map((item) => [item.id, item.status]));
  const noteOf = async (id: string) => (await tasks()).find((item) => item.id === id)?.note;

  async function pass(): Promise<void> {
    await flow.app.app.get(CommandService).idle();
    await flow.app.pipeline.whenIdle(KEY);
    await flow.app.pipeline.step('implement', KEY);
    await flow.app.app.get(CommandService).idle();
    await flow.tick();
    await flow.app.pipeline.whenIdle(KEY);
    await assertInvariants(flow.app);
  }

  async function seedEpic(list: Subtask[]): Promise<void> {
    const parent = await save(runs(), KEY, 'implement', 'waiting');
    parent.split = true;
    parent.projects = 'demo\n';
    parent.codeHost = 'gitlab';
    await runs().saveRun(parent);
    await documents().putDocument(parent, 'requirements', requirements);
    await documents().putDocument(parent, 'repos', 'demo\n');
    await documents().putDocument(parent, 'subtasks', `${JSON.stringify(list)}\n`);
    await pass();
  }

  /** The task's branch is cut from the feature branch as it is, gets one commit on `file`, is pushed and has a merge request. Its run ends in `status`. */
  async function deliver(id: string, file: string, text: string, status: 'done' | 'failed' | 'running' = 'done') {
    const run = (await runs().findRun(`${KEY}-${id}`))!;
    const branch = branchName(run.key, summaryForBranch(requirements, run.key));
    const tree = treeOf(id);
    git(clone(), ['fetch', 'origin']);
    mkdirSync(join(tree, '..'), { recursive: true });
    git(clone(), ['worktree', 'add', '-b', branch, tree, `origin/${FEATURE}`]);
    mkdirSync(join(tree, 'src'), { recursive: true });
    writeFileSync(join(tree, file), text);
    git(tree, ['add', file]);
    git(tree, ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', 'commit', '-m', `feat: ${id}`]);
    git(tree, ['push', 'origin', branch]);
    flow.host.ci.pass(git(tree, ['rev-parse', 'HEAD']));
    const { record } = await flow.host.openMergeRequest({
      project: 'demo',
      source: branch,
      target: FEATURE,
      title: id,
      summary: '',
      draft: false,
    });
    await documents().putDocument(run, 'requirements', requirements);
    await documents().putDocument(run, 'repos', 'demo\n');
    await documents().putDocument(run, 'implementation', '- shipped the task\n');
    run.prompt = `branch: ${FEATURE}\n`;
    await documents().putDocument(run, 'merge_request', renderMergeRequest([record]));
    writeRunState(run, { status, currentStep: status === 'done' ? 'done' : 'implement' });
    await runs().saveRun(run);
    return { run, branch, tree, iid: record.iid };
  }

  /** The steps after the rebase ran: the rebased head is pushed, and CI has its result for it. */
  function pushed(tree: string, branch: string, ci: 'pass' | 'fail'): void {
    git(tree, ['push', '--force', 'origin', branch]);
    if (ci === 'pass') flow.host.ci.pass(git(tree, ['rev-parse', 'HEAD']));
    else flow.host.ci.failBranch(branch, 'test failed on top of the feature branch');
  }

  async function finish(id: string): Promise<void> {
    const run = (await runs().findRun(`${KEY}-${id}`))!;
    writeRunState(run, { status: 'done', currentStep: 'done' });
    await runs().saveRun(run);
  }

  it('rebases a green task that is behind the feature branch, runs its gates again, and merges it with no return counted', async () => {
    realRebases = true;
    await seedEpic([task('a'), task('b')]);
    const first = await deliver('a', 'src/a.ts', 'export const a = 1;\n');
    const second = await deliver('b', 'src/b.ts', 'export const b = 1;\n');

    await pass();

    expect([...flow.host.merged.keys()]).toEqual([first.iid]);
    expect(await statuses()).toEqual({ a: 'merged', b: 'running' });
    // The rebase ran on the worktree: the review of the task stands, so it goes to its checks and CI.
    expect((await runs().findRun(`${KEY}-b`))?.currentStep).toBe('checks');
    const phases = (await flow.app.app.get(FlowRepository).listFlows(second.run.id)).at(-1)?.phases ?? '';
    expect(phases).not.toContain('code-review');
    const tip = git(clone(), ['rev-parse', `origin/${FEATURE}`]);
    expect(rebases).toEqual([
      { key: `${KEY}-b`, payload: { byParent: true }, idempotencyKey: `subtask-rebase-${KEY}-b-${tip}` },
    ]);
    expect(await noteOf('b')).toBe('rebased onto the epic: the feature branch moved on');

    pushed(second.tree, second.branch, 'pass');
    await finish('b');
    // The last merge sends the epic on to its checks, which this spec does not run.
    await flow.app.pipeline.whenIdle(KEY);
    await flow.app.pipeline.step('implement', KEY);

    expect([...flow.host.merged.keys()]).toEqual([first.iid, second.iid]);
    expect(await statuses()).toEqual({ a: 'merged', b: 'merged' });
    expect(rebases).toHaveLength(1);
    expect(flow.host.landed.map((landing) => landing.testedOnTop)).toEqual([true, true]);
  });

  it('keeps the feature branch green when two tasks pass alone and fail together: the second one returns to implement', async () => {
    realRebases = true;
    await seedEpic([task('a'), task('b')]);
    const first = await deliver('a', 'src/a.ts', 'export const a = 1;\n');
    const second = await deliver('b', 'src/b.ts', 'export const b = 1;\n');

    await pass();
    pushed(second.tree, second.branch, 'fail');
    const run = (await runs().findRun(`${KEY}-b`))!;
    writeRunState(run, { status: 'waiting', currentStep: 'implement' });
    await runs().saveRun(run);
    await pass();

    expect([...flow.host.merged.keys()]).toEqual([first.iid]);
    expect(await statuses()).toEqual({ a: 'merged', b: 'running' });
    expect(flow.host.landed.every((landing) => landing.testedOnTop)).toBe(true);
    expect(flow.host.ci.passed(git(second.tree, ['rev-parse', 'HEAD']), second.branch)).toBe(false);
  });

  it('rebases a failed task that a merge put in conflict, with the note on both pages', async () => {
    await seedEpic([task('a', ['src/shared.ts']), task('b', ['src/shared.ts'])]);
    const first = await deliver('a', 'src/shared.ts', 'export const shared = 1;\n');
    const second = await deliver('b', 'src/shared.ts', 'export const shared = 2;\n', 'failed');

    await pass();

    const note = 'rebased onto the epic after a merged (conflict in src/shared.ts)';
    expect([...flow.host.merged.keys()]).toEqual([first.iid]);
    expect(rebases.map((sent) => sent.key)).toEqual([second.run.key]);
    expect(await noteOf('b')).toBe(note);
    expect(await documents().latestBody(second.run.key, 'handoff')).toContain(note);
  });

  it('rebases a working task when its step ends, never by sending it a command', async () => {
    await seedEpic([task('a', ['src/shared.ts']), task('b', ['src/shared.ts'])]);
    await deliver('a', 'src/shared.ts', 'export const shared = 1;\n');
    const second = await deliver('b', 'src/shared.ts', 'export const shared = 2;\n', 'running');

    await pass();

    const note = 'rebased onto the epic after a merged (conflict in src/shared.ts)';
    expect(rebases).toEqual([]);
    expect(await documents().latestBody(second.run.key, 'pending_rebase')).toBe(note);
    const rebase = jest.spyOn(flow.app.app.get(RunRebase), 'rebase').mockResolvedValue('start');

    expect(await flow.app.app.get(SubtaskPort).applyPendingRebase(second.run.key)).toBe('implement');

    expect(rebase).toHaveBeenCalledWith(second.run.key, false, true);
    expect(await documents().latestBody(second.run.key, 'pending_rebase')).toBe('');
    expect(await documents().latestBody(second.run.key, 'handoff')).toContain(note);
  });

  it('sends a rebase again on the next pass when the command that carried it died', async () => {
    realRebases = true;
    await seedEpic([task('a'), task('b')]);
    await deliver('a', 'src/a.ts', 'export const a = 1;\n');
    await deliver('b', 'src/b.ts', 'export const b = 1;\n');
    const service = flow.app.app.get(RunRebaseService);
    const rebase = jest
      .spyOn(service, 'rebase')
      .mockRejectedValueOnce(new ConflictException('the host did not answer'))
      .mockResolvedValue({ key: `${KEY}-b`, status: 'started' });

    await pass();
    // The first command died; the next pass sent the rebase again, once.
    expect(rebase).toHaveBeenCalledTimes(2);
    expect(rebase).toHaveBeenLastCalledWith(`${KEY}-b`, true);

    await pass();
    expect(rebase).toHaveBeenCalledTimes(2);
  });
});
