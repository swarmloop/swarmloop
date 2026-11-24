import 'reflect-metadata';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RunQueriesService } from '../api/run-queries.service';
import { RunRebaseService } from '../api/run-rebase.service';
import { ERROR_CODES } from '../contract/error-codes';
import { CODE_REVIEWERS } from '../contract/steps';
import type { Subtask } from '../contract/subtask';
import { branchName, summaryForBranch } from '../git/naming/git-names';
import { BacklogRepository } from '../history/backlog.repository';
import { CommandRepository } from '../history/command.repository';
import { PlanChatStore } from '../history/plan-chat.store';
import { DocumentRepository } from '../history/document.repository';
import type { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { storedState, writeRunState } from '../history/run-state';
import { VisitRepository } from '../history/visit.repository';
import { CommandService } from '../pipeline/command.service';
import { RunRebase } from '../steps/run-rebase';
import { betweenPasses } from '../steps/shared/epic-between-passes';
import { SubtaskOps } from '../steps/shared/subtask-ops';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { handoffText } from '../steps/shared/handoff';
import { checkDocker } from './check-docker.spec-helpers';
import { FAKE_MODEL_KEY } from './env.spec-helpers';
import { ConflictAgent, createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { git, save } from './runs.spec-helpers';

const KEY = 'PROJ-480';
const FEATURE = `feature/${KEY}-ship-the-field`;
const NOTE = 'rebased onto the epic after main moved on';
const OWNER = 'ada';
const MANIFEST = {
  '.swarmloop.json': JSON.stringify({ version: 1, image: 'node:22', setup: 'npm ci', cache: [], checks: ['npm test'] }),
};

const task = (id: string): Subtask => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  depends: [],
  files: [`src/${id}.ts`],
  proof: `${id}.spec.ts`,
  status: 'waiting',
});

const requirements = `${JSON.stringify({
  prompt: 'Ship the field\n',
  tickets: [{ key: KEY, summary: 'Ship the field' }],
  plan: { name: 'plan', overview: '', items: ['do it'], decision: 'approve' },
})}\n`;

const OWN = ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com'];

describe('a running epic takes what lands on main, from a backlog pass', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  /** The commands the app accepted, in order. */
  let sent: { type: string; key: string }[];
  /** The checks pass in a worktree that holds `src/fix.ts`, the fix that lands on main. */
  const docker = checkDocker((launch) =>
    launch.mounts.some((mount) => existsSync(join(mount.hostPath, 'src', 'fix.ts'))) ? 0 : 1,
  );

  async function boot(repoFiles?: Record<string, string>, blocks?: ConflictAgent): Promise<void> {
    flow = await createFlowHarness(KEY, {
      env: { CHECKOUTS_ROOT: '.', ...FAKE_MODEL_KEY },
      realHost: true,
      taskWorktrees: true,
      realSteps: ['checks'],
      repoFiles,
      blocks,
      sandboxCalls: docker.calls,
    });
    sent = [];
    const commands = flow.app.app.get(CommandService);
    const accept = commands.accept.bind(commands);
    jest.spyOn(commands, 'accept').mockImplementation((type, key, payload, options) => {
      sent.push({ type, key });
      return accept(type, key, payload, options);
    });
    // The origin is an url, so the backlog layer reads a project from it; main is the default branch of the repository.
    git(clone(), ['remote', 'set-url', 'origin', `file://${bare()}`]);
    flow.host.defaultBranchIs('main');
    flow.host.defaultBranchPasses();
  }

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.app.app.get(CommandService).idle();
    await flow.close();
  });

  const runs = () => flow.app.app.get(RunRepository);
  const documents = () => flow.app.app.get(DocumentRepository);
  const clone = () => join(flow.app.root, 'demo');
  const bare = () => join(flow.app.root, 'demo.git');
  const treeOf = (id: string) => join(flow.app.root, 'worktrees', `${KEY}-${id}`, 'demo');
  const childKey = (id: string) => `${KEY}-${id}`;
  const rebaseKeys = () => sent.filter((command) => command.type === 'rebase').map((command) => command.key);

  /** The epic waits between passes, in a backlog of its own, with a run and a worktree for each subtask. */
  async function seedEpic(list: Subtask[], ownFile?: [string, string]): Promise<void> {
    const parent = await save(runs(), KEY, 'implement', 'waiting');
    parent.split = true;
    parent.projects = 'demo\n';
    parent.codeHost = 'gitlab';
    await runs().saveRun(parent);
    await documents().putDocument(parent, 'requirements', requirements);
    await documents().putDocument(parent, 'repos', 'demo\n');
    await documents().putDocument(parent, 'implementation', '- the epic\n');
    await documents().putDocument(parent, 'subtasks', `${JSON.stringify(list)}\n`);
    if (ownFile) {
      mkdirSync(join(flow.tree, 'src'), { recursive: true });
      writeFileSync(join(flow.tree, ownFile[0]), ownFile[1]);
      git(flow.tree, ['add', ownFile[0]]);
      git(flow.tree, [...OWN, 'commit', '-m', 'feat: the epic']);
      git(flow.tree, ['push', 'origin', FEATURE]);
    }
    git(clone(), ['fetch', 'origin']);
    for (const item of list) {
      const run = await save(runs(), childKey(item.id), 'implement', 'waiting');
      run.parentRunId = parent.id;
      run.taskId = item.id;
      run.codeHost = 'gitlab';
      run.prompt = `branch: ${FEATURE}\n`;
      await runs().saveRun(run);
      for (const [kind, body] of [
        ['requirements', requirements],
        ['repos', 'demo\n'],
        ['implementation', '- shipped the task\n'],
      ]) {
        await documents().putDocument(run, kind, body);
      }
      mkdirSync(join(treeOf(item.id), '..'), { recursive: true });
      const branch = branchName(run.key, summaryForBranch(requirements, run.key));
      git(clone(), ['worktree', 'add', '-b', branch, treeOf(item.id), `origin/${FEATURE}`]);
      commitIn(treeOf(item.id), `src/${item.id}.ts`, `export const ${item.id} = 1;\n`);
    }
    writeRunState(parent, {
      status: 'waiting',
      currentStep: 'implement',
      reason: { code: ERROR_CODES.SUBTASKS_RUNNING, message: 'subtasks run' },
    });
    await runs().saveRun(parent);
    await seedBacklog();
  }

  function commitIn(tree: string, file: string, text: string): void {
    mkdirSync(join(tree, 'src'), { recursive: true });
    writeFileSync(join(tree, file), text);
    git(tree, ['add', file]);
    git(tree, [...OWN, 'commit', '-m', `feat: ${file}`]);
  }

  /** A backlog whose one task is the epic, as a start of the backlog left it. */
  async function seedBacklog(): Promise<void> {
    flow.backlog();
    const backlogs = flow.app.app.get(BacklogRepository);
    const at = new Date(flow.app.clock.now()).toISOString();
    const backlog = await backlogs.saveBacklog({
      name: 'shop',
      owner: OWNER,
      repositories: ['demo'],
      mergeMode: 'green',
      paused: false,
      createdAt: at,
    });
    const milestone = await backlogs.saveMilestone({
      backlogId: backlog.id as number,
      number: 1,
      title: 'M1',
      goal: '',
      status: 'active',
      createdAt: at,
    });
    await backlogs.saveTask({
      backlogId: backlog.id as number,
      milestoneId: milestone.id as number,
      slug: 'epic',
      title: 'The epic',
      description: 'Ship the field',
      repositories: ['demo'],
      covers: [],
      depends: [],
      files: [],
      proof: [],
      manual: false,
      fixesMain: null,
      status: 'waiting',
      runKey: KEY,
      note: '',
      runNow: false,
      mergeOk: false,
      merged: {},
      madeBy: 'person',
      position: 1,
      createdAt: at,
    });
  }

  /** A commit on main, pushed to origin from a clone of its own; the sha. */
  function landOnMain(file: string, text: string): string {
    const other = mkdtempSync(join(tmpdir(), 'swarmloop-main-'));
    try {
      git(other, ['clone', '--branch', 'main', bare(), 'main-clone']);
      const work = join(other, 'main-clone');
      commitIn(work, file, text);
      git(work, ['push', 'origin', 'main']);
      return git(work, ['rev-parse', 'HEAD']);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  }

  /** One pass of the backlog, and every command it started has ended. */
  async function backlogPass(): Promise<void> {
    await flow.backlog().scheduler.tick();
    await flow.app.app.get(CommandService).idle();
    await flow.app.app.get(CommandService).idle();
    await flow.app.pipeline.whenIdle(KEY);
  }

  /** Every command the epic's route started has ended, the moves of its tasks among them. */
  async function settleAll(): Promise<void> {
    for (let round = 0; round < 3; round += 1) {
      await flow.app.app.get(CommandService).idle();
      for (const key of [KEY, childKey('a'), childKey('b')]) await flow.app.pipeline.whenIdle(key);
    }
  }

  async function block(id: string, code: string, step: string): Promise<void> {
    const run = (await runs().findRun(childKey(id)))!;
    writeRunState(run, { status: 'blocked', currentStep: step, reason: { code, message: 'blocked' } });
    await runs().saveRun(run);
  }

  const isIn = (tree: string, sha: string): boolean => {
    try {
      git(tree, ['merge-base', '--is-ancestor', sha, 'HEAD']);
      return true;
    } catch {
      return false;
    }
  };
  const notes = async (id: string) => handoffText(await documents().latestBody(childKey(id), 'handoff'));
  const stateOf = async (key: string) => storedState((await runs().findRun(key))!);

  it('moves the epic and its subtasks with no person, and the subtask blocked by a check passes its checks on the new tree', async () => {
    await boot(MANIFEST);
    await seedEpic([task('a'), task('b'), task('c')]);
    await block('b', ERROR_CODES.CHECK_FAILED, 'checks');
    await block('c', ERROR_CODES.PIPELINE_UNFIXED, 'pipeline');
    const head = landOnMain('src/fix.ts', 'export const fix = 1;\n');

    await backlogPass();

    expect(isIn(flow.tree, head)).toBe(true);
    expect(git(bare(), ['rev-parse', FEATURE])).toBe(git(flow.tree, ['rev-parse', 'HEAD']));
    expect(rebaseKeys()[0]).toBe(KEY);
    expect(new Set(rebaseKeys())).toEqual(new Set([KEY, childKey('a'), childKey('b'), childKey('c')]));
    expect(flow.launched).toContain(childKey('b'));
    for (const id of ['a', 'b', 'c']) {
      expect(isIn(treeOf(id), git(flow.tree, ['rev-parse', 'HEAD']))).toBe(true);
      expect(await notes(id)).toContain(NOTE);
    }
    // A subtask blocked for another reason is moved and stays blocked.
    expect((await stateOf(childKey('c'))).state).toBe('blocked');
    // The machine started b again at its checks; they pass on the new tree and fail on the old one.
    const visits = flow.app.app.get(VisitRepository);
    const before = (await visits.listStats((await runs().findRun(childKey('b')))!.id)).length;
    await flow.app.pipeline.step('checks', childKey('b'));
    const after = await visits.listStats((await runs().findRun(childKey('b')))!.id);
    expect(after.slice(before).map((visit) => visit.step)).toEqual(['checks']);
    expect((await stateOf(childKey('b'))).state).not.toBe('blocked');
    expect(docker.spawned.at(-1)?.mounts.some((mount) => existsSync(join(mount.hostPath, 'src', 'fix.ts')))).toBe(true);
    expect(sent.every((command) => ['rebase', 'resume'].includes(command.type))).toBe(true);
  });

  it('moves an epic that has no commit of its own, and a check-blocked subtask whose work conflicts goes to implement', async () => {
    await boot();
    await seedEpic([task('a'), task('b')]);
    // b changes the file that main changes too.
    commitIn(treeOf('b'), 'src/readme.ts', 'export const readme = 2;\n');
    await block('b', ERROR_CODES.CHECK_FAILED, 'checks');
    const head = landOnMain('src/readme.ts', 'export const readme = 3;\n');

    await backlogPass();

    expect(git(flow.tree, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(bare(), ['rev-parse', FEATURE])).toBe(head);
    expect(isIn(treeOf('a'), head)).toBe(true);
    const conflicted = (await runs().findRun(childKey('b')))!;
    expect(conflicted.currentStep).toBe('implement');
    expect(storedState(conflicted).state).not.toBe('blocked');
    expect(await documents().latestBody(childKey('b'), 'rebase_conflict')).toMatch(/pending/);
  });

  it('waits while a subtask runs, then moves the epic; a subtask that starts before its move gets the note as a pending rebase', async () => {
    await boot();
    await seedEpic([task('a')]);
    const child = (await runs().findRun(childKey('a')))!;
    writeRunState(child, { status: 'running', currentStep: 'implement' });
    await runs().saveRun(child);
    landOnMain('src/fix.ts', 'export const fix = 1;\n');

    await backlogPass();
    expect(rebaseKeys()).toEqual([]);

    writeRunState(child, { status: 'waiting', currentStep: 'implement' });
    await runs().saveRun(child);
    // The subtask starts after the epic's rebase ended and before the subtasks are moved.
    const rebase = flow.app.app.get(RunRebase);
    const real = rebase.rebase.bind(rebase);
    jest.spyOn(rebase, 'rebase').mockImplementation(async (key, ...rest) => {
      const next = await real(key, ...rest);
      if (key === KEY) {
        const started = (await runs().findRun(childKey('a')))!;
        writeRunState(started, { status: 'running', currentStep: 'implement' });
        await runs().saveRun(started);
      }
      return next;
    });
    await backlogPass();

    expect(rebaseKeys()).toEqual([KEY]);
    expect(await documents().latestBody(childKey('a'), 'pending_rebase')).toContain(NOTE);
  });

  /** The agent of the epic's implement step resolves the conflict in the epic's worktree, and so the checks pass on it. */
  const resolver = () =>
    new ConflictAgent(() => {
      writeFileSync(join(flow.tree, 'src', 'readme.ts'), 'export const readme = 4;\n');
      writeFileSync(join(flow.tree, 'src', 'fix.ts'), 'export const fix = 1;\n');
    });

  /** An epic with a task that waits and a task blocked by a check; its own commit conflicts with the head that lands on main. */
  async function conflictingEpic(): Promise<string> {
    await seedEpic([task('a'), task('b')], ['src/readme.ts', 'export const readme = 2;\n']);
    await documents().putDocument(
      (await runs().findRun(KEY))!,
      'requirement_list',
      '[{"id":"R1","text":"ship the field"}]\n',
    );
    await block('b', ERROR_CODES.CHECK_FAILED, 'checks');
    return landOnMain('src/readme.ts', 'export const readme = 3;\n');
  }

  /** What the app did on its way: each task's move with what had happened before it, and every stored state of the epic. */
  function watch() {
    const moves: { key: string; pushed: boolean; reviewers: number }[] = [];
    const states: string[] = [];
    const ops = flow.app.app.get(SubtaskOps);
    const move = ops.rebase.bind(ops);
    jest.spyOn(ops, 'rebase').mockImplementation((child, ...rest) => {
      const reviewers = REVIEWERS.filter((name) => agentOf().steps.includes(name)).length;
      moves.push({
        key: child.key,
        pushed: git(bare(), ['rev-parse', FEATURE]) === git(flow.tree, ['rev-parse', 'HEAD']),
        reviewers,
      });
      return move(child, ...rest);
    });
    // Every write of the epic's state, whichever way it is made.
    for (const write of ['saveRun', 'claim', 'release'] as const) {
      const real = runs()[write].bind(runs()) as (...args: unknown[]) => Promise<RunEntity>;
      jest.spyOn(runs(), write).mockImplementation((...args: unknown[]) =>
        real(...args).then((run) => {
          if (run.key === KEY) states.push(storedState(run).state);
          return run;
        }),
      );
    }
    return { moves, states };
  }

  const REVIEWERS = CODE_REVIEWERS.map((name) => `code-review-${name}`);
  const agentOf = () => flow.app.blocks as ConflictAgent;

  /** The route of a resolved conflict, seen after the epic waits between passes again. */
  async function expectResolved(
    head: string,
    seen: ReturnType<typeof watch>,
    options: { moved: string[]; note: boolean },
  ) {
    const agent = agentOf();
    expect(agent.conflicts).toHaveLength(1);
    expect(agent.conflicts[0]).toContain('src/readme.ts');
    for (const reviewer of REVIEWERS) expect(agent.steps.filter((step) => step === reviewer)).toHaveLength(1);
    const list = JSON.parse((await documents().latestBody(KEY, 'subtasks')) ?? '[]') as Subtask[];
    expect(list.map((item) => item.id)).toEqual(['a', 'b']);
    expect(isIn(flow.tree, head)).toBe(true);
    const tip = git(flow.tree, ['rev-parse', 'HEAD']);
    expect(git(bare(), ['rev-parse', FEATURE])).toBe(tip);
    // Every open task was sent its move once, after the five reviewers passed and the branch was pushed; a task that cannot take it now stays as it was.
    expect(seen.moves.map((move) => move.key).sort()).toEqual([childKey('a'), childKey('b')]);
    for (const move of seen.moves) expect(move).toMatchObject({ pushed: true, reviewers: REVIEWERS.length });
    for (const id of options.moved) {
      expect(isIn(treeOf(id), tip)).toBe(true);
      expect((await notes(id)).includes(NOTE)).toBe(options.note);
    }
    expect(seen.states).toContain('running');
    expect(seen.states).not.toContain('blocked');
    expect(seen.states).not.toContain('failed');
    expect(betweenPasses((await runs().findRun(KEY))!)).toBe(true);
    expect((await flow.app.app.get(PlanChatStore).read(KEY)).entries).toEqual([]);
  }

  /** The check-blocked task was started again at its checks once, on a tree that holds the fix, where they pass. */
  async function expectChecksOnNewTree(): Promise<void> {
    expect(flow.launched.filter((key) => key === childKey('b'))).toHaveLength(1);
    expect(existsSync(join(treeOf('b'), 'src', 'fix.ts'))).toBe(true);
    expect((await stateOf(childKey('b'))).state).not.toBe('blocked');
  }

  it('an epic whose own work conflicts with main has implement resolve it, checks and review judge it, then its open tasks move onto the pushed branch', async () => {
    await boot(MANIFEST, resolver());
    const head = await conflictingEpic();
    const seen = watch();

    await backlogPass();
    await settleAll();

    await expectResolved(head, seen, { moved: ['a', 'b'], note: true });
    await expectChecksOnNewTree();
    expect(rebaseKeys().filter((key) => key === KEY)).toHaveLength(1);
    expect(sent.every((command) => ['rebase', 'resume'].includes(command.type))).toBe(true);
    await assertInvariants(flow.app);
  });

  it("has implement resolve the conflict of a person's Rebase of an epic whose tasks are open, then moves each task with a plain rebase", async () => {
    await boot(MANIFEST, resolver());
    const head = await conflictingEpic();
    // A plain rebase moves a task that has a merge request, and leaves a blocked one as it is.
    for (const id of ['a', 'b']) {
      const child = (await runs().findRun(childKey(id)))!;
      const { record } = await flow.host.openMergeRequest({
        project: 'group/demo',
        source: branchName(child.key, summaryForBranch(requirements, child.key)),
        target: 'main',
        title: `feat: task ${id}`,
        summary: '',
        draft: false,
      });
      await documents().putDocument(child, 'merge_request', renderMergeRequest([{ ...record, summary: '' }]));
    }
    const seen = watch();

    await flow.app.app.get(RunRebaseService).rebase(KEY);
    await settleAll();

    await expectResolved(head, seen, { moved: ['a'], note: false });
    expect((await stateOf(childKey('b'))).state).toBe('blocked');
    expect(sent.every((command) => ['rebase', 'resume'].includes(command.type))).toBe(true);
    await assertInvariants(flow.app);
  });

  describe("a run that today's main blocked on a main move that conflicted", () => {
    const SENTENCE =
      'The rebase stopped at a conflict with the base branch. Resume has the implement agent resolve it; checks and code review judge the resolution, then the open tasks move onto the resolved branch.';

    /** The epic as the backlog pass left it: the rebase parked at implement, blocked REBASE_CONFLICT, its rebase command stored. */
    async function storedBlock(): Promise<string> {
      const head = await conflictingEpic();
      await flow.app.app.get(RunRebase).rebase(KEY, false, false, true);
      const parent = (await runs().findRun(KEY))!;
      writeRunState(parent, {
        status: 'blocked',
        currentStep: 'implement',
        reason: {
          code: ERROR_CODES.REBASE_CONFLICT,
          message: 'demo conflicts with main in src/readme.ts; the epic stays on its branch until a person replays it',
        },
      });
      await runs().saveRun(parent);
      const commands = flow.app.app.get(CommandRepository);
      const stored = await commands.accept({
        type: 'rebase',
        key: KEY,
        payload: { main: `demo at ${head}` },
        idempotencyKey: `epic-main-${KEY}-demo@${head}`,
        admit: () => undefined,
      });
      await commands.start(stored.command.id);
      await commands.finish(stored.command.id, 'succeeded', null);
      return head;
    }

    async function expectResumable(): Promise<void> {
      const view = await flow.app.app.get(RunQueriesService).flow(KEY);
      expect(view.actions).toContain('resume');
      expect(view.sentence).toBe(SENTENCE);
      expect(await documents().latestBody(KEY, 'rebase_conflict')).toMatch(/^pending-implement/);
      await assertInvariants(flow.app).then(
        () => {
          throw new Error('the stored block must break the conflict invariant');
        },
        (error: Error) => expect(error.message).toContain('on a rebase conflict that implement or a planner holds'),
      );
    }

    it('with a task blocked by a check offers Resume, and Resume resolves the conflict and moves the tasks', async () => {
      await boot(MANIFEST, resolver());
      const head = await storedBlock();
      await expectResumable();
      const seen = watch();

      await flow.person('resume');
      await settleAll();

      await expectResolved(head, seen, { moved: ['a', 'b'], note: true });
      await expectChecksOnNewTree();
      await assertInvariants(flow.app);
    });

    it('with a task running offers Resume, and Resume queues the running task its rebase', async () => {
      await boot(MANIFEST, resolver());
      const head = await storedBlock();
      const running = (await runs().findRun(childKey('a')))!;
      writeRunState(running, { status: 'running', currentStep: 'implement' });
      await runs().saveRun(running);
      const settled = (await runs().findRun(childKey('b')))!;
      writeRunState(settled, { status: 'waiting', currentStep: 'implement' });
      await runs().saveRun(settled);
      await expectResumable();
      const seen = watch();

      await flow.person('resume');
      await settleAll();

      expect(await documents().latestBody(childKey('a'), 'pending_rebase')).toContain(NOTE);
      await expectResolved(head, seen, { moved: ['b'], note: true });
      await assertInvariants(flow.app);
    });
  });

  it('keeps Replay only and its sentence for a block of a recreated worktree', async () => {
    await boot();
    await seedEpic([task('a')]);
    const parent = (await runs().findRun(KEY))!;
    writeRunState(parent, {
      status: 'blocked',
      currentStep: 'implement',
      reason: { code: ERROR_CODES.REBASE_CONFLICT, message: 'demo was recreated during a rebase' },
    });
    await runs().saveRun(parent);
    await documents().putDocument(
      parent,
      'rebase_journal',
      JSON.stringify({
        demo: { path: treeOf('a'), branch: FEATURE, checkpoint: 'applying', generation: parent.generation },
      }),
    );

    const view = await flow.app.app.get(RunQueriesService).flow(KEY);

    expect(view.actions).toEqual(['replay']);
    expect(view.sentence).toBe('This run is blocked. Another return is not available.');
    await assertInvariants(flow.app);
  });
});
