import 'reflect-metadata';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ERROR_CODES } from '../contract/error-codes';
import type { Subtask } from '../contract/subtask';
import { branchName, summaryForBranch } from '../git/naming/git-names';
import { BacklogRepository } from '../history/backlog.repository';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { storedState, writeRunState } from '../history/run-state';
import { VisitRepository } from '../history/visit.repository';
import { CommandService } from '../pipeline/command.service';
import { RunRebase } from '../steps/run-rebase';
import { handoffText } from '../steps/shared/handoff';
import { checkDocker } from './check-docker.spec-helpers';
import { FAKE_MODEL_KEY } from './env.spec-helpers';
import { createFlowHarness } from './flow-harness';
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

  async function boot(repoFiles?: Record<string, string>): Promise<void> {
    flow = await createFlowHarness(KEY, {
      env: { CHECKOUTS_ROOT: '.', ...FAKE_MODEL_KEY },
      realHost: true,
      taskWorktrees: true,
      realSteps: ['checks'],
      repoFiles,
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

  it('sends an epic whose own work conflicts with main to implement and never blocks it with REBASE_CONFLICT', async () => {
    await boot();
    await seedEpic([task('a')], ['src/readme.ts', 'export const readme = 2;\n']);
    landOnMain('src/readme.ts', 'export const readme = 3;\n');

    await backlogPass();

    const { reason } = await stateOf(KEY);
    expect(reason?.code).not.toBe(ERROR_CODES.REBASE_CONFLICT);
  });
});
