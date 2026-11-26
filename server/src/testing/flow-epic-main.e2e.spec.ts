import 'reflect-metadata';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { RunQueriesService } from '../api/run-queries.service';
import { RunRebaseService } from '../api/run-rebase.service';
import { ERROR_CODES } from '../contract/error-codes';
import { CODE_REVIEWERS } from '../contract/steps';
import type { Subtask } from '../contract/subtask';
import { branchName, summaryForBranch } from '../git/naming/git-names';
import { CommandRepository } from '../history/command.repository';
import { PlanChatStore } from '../history/plan-chat.store';
import type { RunEntity } from '../history/entities';
import { storeRun } from './store-run.spec-helpers';
import { storedState, writeRunState } from '../history/run-state';
import { VisitRepository } from '../history/visit.repository';
import { CommandService } from '../pipeline/command.service';
import { RunRebase } from '../steps/run-rebase';
import { betweenPasses } from '../steps/shared/epic-between-passes';
import { SubtaskOps } from '../steps/shared/subtask-ops';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';
import { checkDocker } from './check-docker.spec-helpers';
import { agentFor } from '../config/agents';
import { AppConfig } from '../config/env';
import { agentStateDir } from '../sandbox/sandbox-launch';
import { RunStateRefresh } from '../steps/shared/run-state-refresh';
import {
  bootEpicFlow,
  epicMainKit,
  FEATURE,
  KEY,
  MANIFEST,
  NOTE,
  requirements,
  task,
} from './flow-epic-main.spec-helpers';
import type { createFlowHarness } from './flow-harness';
import { ConflictAgent } from './flow-harness';
import { BlockAgentRunner } from './result-answer';
import { assertInvariants } from './flow-invariants';
import { git } from './runs.spec-helpers';

describe('a running epic takes what lands on main, from a backlog pass', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  /** The commands the app accepted, in order. */
  let sent: { type: string; key: string }[];
  /** The checks pass in a worktree that holds `src/fix.ts`, the fix that lands on main. */
  const docker = checkDocker((launch) =>
    launch.mounts.some((mount) => existsSync(join(mount.hostPath, 'src', 'fix.ts'))) ? 0 : 1,
  );

  async function boot(repoFiles?: Record<string, string>, blocks?: BlockAgentRunner): Promise<void> {
    sent = [];
    flow = await bootEpicFlow(sent, docker, repoFiles, blocks);
  }

  const {
    runs,
    documents,
    bare,
    treeOf,
    childKey,
    seedEpic,
    commitIn,
    landOnMain,
    backlogPass,
    settleAll,
    block,
    isIn,
    notes,
    stateOf,
    ask,
    waitingKept,
  } = epicMainKit(() => flow);

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.app.app.get(CommandService).idle();
    await flow.close();
  });

  const rebaseKeys = () => sent.filter((command) => command.type === 'rebase').map((command) => command.key);

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
    await storeRun(runs(), child);
    landOnMain('src/fix.ts', 'export const fix = 1;\n');

    await backlogPass();
    expect(rebaseKeys()).toEqual([]);

    writeRunState(child, { status: 'waiting', currentStep: 'implement' });
    await storeRun(runs(), child);
    // The subtask starts after the epic's rebase ended and before the subtasks are moved.
    const rebase = flow.app.app.get(RunRebase);
    const real = rebase.rebase.bind(rebase);
    jest.spyOn(rebase, 'rebase').mockImplementation(async (key, ...rest) => {
      const next = await real(key, ...rest);
      if (key === KEY) {
        const started = (await runs().findRun(childKey('a')))!;
        writeRunState(started, { status: 'running', currentStep: 'implement' });
        await storeRun(runs(), started);
      }
      return next;
    });
    await backlogPass();

    expect(rebaseKeys()).toEqual([KEY]);
    expect(await documents().latestBody(childKey('a'), 'pending_rebase')).toContain(NOTE);
  });

  it("a person's Rebase of an epic publishes the rebased branch and moves every open part onto it, a part that waits on a question or a sibling keeping its wait", async () => {
    await boot();
    await seedEpic([task('a'), task('b'), task('c')], ['src/own.ts', 'export const own = 1;\n']);
    const child = (await runs().findRun(childKey('a')))!;
    const { record } = await flow.host.openMergeRequest({
      project: 'group/demo',
      source: branchName(child.key, summaryForBranch(requirements, child.key)),
      target: 'main',
      title: 'feat: task a',
      summary: '',
      draft: false,
    });
    await documents().putDocument(child, 'merge_request', renderMergeRequest([{ ...record, summary: '' }]));
    await ask('b');
    await documents().putDocument((await runs().findRun(childKey('c')))!, 'questions', '');
    await block('c', ERROR_CODES.SUBTASK_WAITING, 'research');
    const waiting = (await runs().findRun(childKey('c')))!;
    writeRunState(waiting, {
      status: 'waiting',
      currentStep: 'research',
      reason: { code: ERROR_CODES.SUBTASK_WAITING, message: 'waits for a sibling' },
    });
    await storeRun(runs(), waiting);
    landOnMain('src/fix.ts', 'export const fix = 1;\n');

    await flow.app.app.get(RunRebaseService).rebase(KEY);
    await settleAll();

    const tip = git(flow.tree, ['rev-parse', 'HEAD']);
    expect(git(bare(), ['rev-parse', FEATURE])).toBe(tip);
    for (const id of ['a', 'b', 'c']) expect(isIn(treeOf(id), tip)).toBe(true);
    expect(await waitingKept('b')).toEqual({ state: 'waiting', step: 'research', started: false });
    expect(await waitingKept('c')).toEqual({ state: 'waiting', step: 'research', started: false });
    expect((await stateOf(childKey('c'))).reason?.code).toBe(ERROR_CODES.SUBTASK_WAITING);
  });

  it('an epic that takes main through a rewrite of its branch moves a part with no commit of its own onto the new tip, keeping its question, with no agent start and no commit', async () => {
    await boot();
    await seedEpic([task('a')], ['src/own.ts', 'export const own = 1;\n']);
    // The part has nothing of its own: it stands on the epic's tip, as it was made.
    git(treeOf('a'), ['reset', '--hard', `origin/${FEATURE}`]);
    const oldTip = git(treeOf('a'), ['rev-parse', 'HEAD']);
    await ask('a');
    landOnMain('src/fix.ts', 'export const fix = 1;\n');

    await flow.app.app.get(RunRebaseService).rebase(KEY);
    await settleAll();

    const tip = git(flow.tree, ['rev-parse', 'HEAD']);
    expect(isIn(flow.tree, oldTip)).toBe(false);
    expect(git(treeOf('a'), ['rev-parse', 'HEAD'])).toBe(tip);
    expect(await waitingKept('a')).toEqual({ state: 'waiting', step: 'research', started: false });
    expect(await documents().latestBody(childKey('a'), 'questions')).toContain('Which type are the ids?');
  });

  it('an epic whose only open part waits on a question takes a new green main; the part keeps its question and its answer runs it on the new tree', async () => {
    const planner = new BlockAgentRunner({ plan: [{ block: { escalate: 'The owner must decide.' } }] });
    await boot(undefined, planner);
    await seedEpic([task('a')]);
    await ask('a');
    // The epic's pass hands the part's question up to whoever started the run, and waits on it.
    const root = flow.app.root;
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(agentStateDir(root, KEY, 'plan'), { recursive: true });
    const runtime = agentFor(flow.app.app.get(AppConfig).env, await runs().findRun(KEY), 'plan').runtime;
    writeFileSync(join(root, 'data', `${KEY}-plan-session.json`), JSON.stringify({ chatId: 'chat-1', runtime }));
    await documents().putDocument((await runs().findRun(KEY))!, 'contract', '- api (owner a): the api\n');
    await flow.app.pipeline.step('implement', KEY);
    await flow.app.app.get(CommandService).idle();
    await flow.app.app.get(RunStateRefresh).settled();
    expect((await stateOf(KEY)).reason?.code).toBe('ASKS_PLANNER');
    const head = landOnMain('src/fix.ts', 'export const fix = 1;\n');

    await backlogPass();
    await settleAll();

    expect(isIn(flow.tree, head)).toBe(true);
    expect(isIn(treeOf('a'), head)).toBe(true);
    expect(await waitingKept('a')).toEqual({ state: 'waiting', step: 'research', started: false });
    expect(await documents().latestBody(childKey('a'), 'answers')).toBeNull();
    // The move restarted the epic's pass; its question is still open, so it waits on it again.
    expect(await stateOf(KEY)).toMatchObject({
      state: 'waiting',
      reason: { code: expect.stringMatching(/ASKS_PLANNER|NEEDS_ANSWERS/) },
    });

    await flow.app.app.get(SubtaskOps).deliverAnswer((await runs().findRun(childKey('a')))!, 'Ids are numbers.');
    await settleAll();

    expect(flow.launched).toContain(childKey('a'));
    expect(isIn(treeOf('a'), head)).toBe(true);
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
    for (const write of ['change', 'insertRun', 'claim', 'release'] as const) {
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
    // The task carries only its own commit on the pushed branch: main does not touch what it changes, so its move is clean.
    expect(git(treeOf('b'), ['rev-parse', 'HEAD~1'])).toBe(git(flow.tree, ['rev-parse', 'HEAD']));
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
      await storeRun(runs(), parent);
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
      await storeRun(runs(), running);
      const settled = (await runs().findRun(childKey('b')))!;
      writeRunState(settled, { status: 'waiting', currentStep: 'implement' });
      await storeRun(runs(), settled);
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
    await storeRun(runs(), parent);
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
