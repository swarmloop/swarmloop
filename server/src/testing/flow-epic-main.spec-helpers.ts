import 'reflect-metadata';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { agentFor } from '../config/agents';
import { AppConfig } from '../config/env';
import { ERROR_CODES } from '../contract/error-codes';
import type { Subtask } from '../contract/subtask';
import { branchName, summaryForBranch } from '../git/naming/git-names';
import { BacklogRepository } from '../history/backlog.repository';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { storedState, writeRunState } from '../history/run-state';
import { CommandService } from '../pipeline/command.service';
import { agentStateDir } from '../sandbox/sandbox-launch';
import { handoffText } from '../steps/shared/handoff';
import { RunStateRefresh } from '../steps/shared/run-state-refresh';
import type { checkDocker } from './check-docker.spec-helpers';
import { FAKE_MODEL_KEY } from './env.spec-helpers';
import { createFlowHarness } from './flow-harness';
import type { BlockAgentRunner } from './result-answer';
import { git, save } from './runs.spec-helpers';
import { storeRun } from './store-run.spec-helpers';

type Flow = Awaited<ReturnType<typeof createFlowHarness>>;

export const KEY = 'PROJ-480';
export const FEATURE = `feature/${KEY}-ship-the-field`;
export const NOTE = 'rebased onto the epic after main moved on';
const OWNER = 'ada';
export const MANIFEST = {
  '.swarmloop.json': JSON.stringify({ version: 1, image: 'node:22', setup: 'npm ci', cache: [], checks: ['npm test'] }),
};

export const task = (id: string): Subtask => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  depends: [],
  files: [`src/${id}.ts`],
  proof: `${id}.spec.ts`,
  status: 'waiting',
});

export const requirements = `${JSON.stringify({
  prompt: 'Ship the field\n',
  tickets: [{ key: KEY, summary: 'Ship the field' }],
  plan: { name: 'plan', overview: '', items: ['do it'], decision: 'approve' },
})}\n`;

const OWN = ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com'];

/**
 * Boots the flow of an epic in a repository with a real origin whose default branch is main, which reads green unless `greenMain` is off. Every command the app accepts
 * is pushed onto `sent`.
 */
export async function bootEpicFlow(
  sent: { type: string; key: string }[],
  docker: ReturnType<typeof checkDocker>,
  repoFiles?: Record<string, string>,
  blocks?: BlockAgentRunner,
  greenMain = true,
): Promise<Flow> {
  const flow = await createFlowHarness(KEY, {
    env: { CHECKOUTS_ROOT: '.', ...FAKE_MODEL_KEY },
    realHost: true,
    taskWorktrees: true,
    realSteps: ['checks'],
    repoFiles,
    blocks,
    sandboxCalls: docker.calls,
  });
  const commands = flow.app.app.get(CommandService);
  const accept = commands.accept.bind(commands);
  jest.spyOn(commands, 'accept').mockImplementation((type, key, payload, options) => {
    sent.push({ type, key });
    return accept(type, key, payload, options);
  });
  // The origin is an url, so the backlog layer reads a project from it; main is the default branch of the repository.
  git(join(flow.app.root, 'demo'), ['remote', 'set-url', 'origin', `file://${join(flow.app.root, 'demo.git')}`]);
  flow.host.defaultBranchIs('main');
  if (greenMain) flow.host.defaultBranchPasses();
  return flow;
}

/** The helpers of the flows of an epic: its paths, its seed, a commit on main, a backlog pass and the parts' states. */
export function epicMainKit(flow: () => Flow) {
  const runs = () => flow().app.app.get(RunRepository);
  const documents = () => flow().app.app.get(DocumentRepository);
  const clone = () => join(flow().app.root, 'demo');
  const bare = () => join(flow().app.root, 'demo.git');
  const treeOf = (id: string) => join(flow().app.root, 'worktrees', `${KEY}-${id}`, 'demo');
  const childKey = (id: string) => `${KEY}-${id}`;
  /** The epic waits between passes, in a backlog of its own, with a run and a worktree for each subtask. */
  async function seedEpic(list: Subtask[], ownFile?: [string, string]): Promise<void> {
    const parent = await save(runs(), KEY, 'implement', 'waiting');
    parent.split = true;
    parent.projects = 'demo\n';
    parent.codeHost = 'gitlab';
    await storeRun(runs(), parent);
    await documents().putDocument(parent, 'requirements', requirements);
    await documents().putDocument(parent, 'repos', 'demo\n');
    await documents().putDocument(parent, 'implementation', '- the epic\n');
    await documents().putDocument(parent, 'subtasks', `${JSON.stringify(list)}\n`);
    if (ownFile) {
      mkdirSync(join(flow().tree, 'src'), { recursive: true });
      writeFileSync(join(flow().tree, ownFile[0]), ownFile[1]);
      git(flow().tree, ['add', ownFile[0]]);
      git(flow().tree, [...OWN, 'commit', '-m', 'feat: the epic']);
      git(flow().tree, ['push', 'origin', FEATURE]);
    }
    git(clone(), ['fetch', 'origin']);
    for (const item of list) {
      const run = await save(runs(), childKey(item.id), 'implement', 'waiting');
      run.parentRunId = parent.id;
      run.taskId = item.id;
      run.codeHost = 'gitlab';
      run.prompt = `branch: ${FEATURE}\n`;
      await storeRun(runs(), run);
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
    await storeRun(runs(), parent);
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
    flow().backlog();
    const backlogs = flow().app.app.get(BacklogRepository);
    const at = new Date(flow().app.clock.now()).toISOString();
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
    await flow().backlog().scheduler.tick();
    await flow().app.app.get(CommandService).idle();
    await flow().app.app.get(CommandService).idle();
    await flow().app.pipeline.whenIdle(KEY);
  }

  /** Every command the epic's route started has ended, the moves of its tasks among them. */
  async function settleAll(): Promise<void> {
    for (let round = 0; round < 3; round += 1) {
      await flow().app.app.get(CommandService).idle();
      for (const key of [KEY, childKey('a'), childKey('b')]) await flow().app.pipeline.whenIdle(key);
    }
  }

  async function block(id: string, code: string, step: string): Promise<void> {
    const run = (await runs().findRun(childKey(id)))!;
    writeRunState(run, { status: 'blocked', currentStep: step, reason: { code, message: 'blocked' } });
    await storeRun(runs(), run);
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

  /** A part waits in research on the question of its document, as a part that asked leaves it. */
  async function ask(id: string): Promise<void> {
    const run = (await runs().findRun(childKey(id)))!;
    await documents().putDocument(run, 'questions', '- Which type are the ids?\n');
    writeRunState(run, { status: 'waiting', currentStep: 'research', facts: { needsAnswers: true } });
    await storeRun(runs(), run);
  }

  /** The epic's pass hands its part's question up to whoever started the run, and the epic waits on its planner. */
  async function handUpQuestion(): Promise<void> {
    const root = flow().app.root;
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(agentStateDir(root, KEY, 'plan'), { recursive: true });
    const runtime = agentFor(flow().app.app.get(AppConfig).env, await runs().findRun(KEY), 'plan').runtime;
    writeFileSync(join(root, 'data', `${KEY}-plan-session.json`), JSON.stringify({ chatId: 'chat-1', runtime }));
    await documents().putDocument((await runs().findRun(KEY))!, 'contract', '- api (owner a): the api\n');
    await flow().app.pipeline.step('implement', KEY);
    await flow().app.app.get(CommandService).idle();
    await flow().app.app.get(RunStateRefresh).settled();
  }

  const waitingKept = async (id: string) => {
    const state = await stateOf(childKey(id));
    const run = (await runs().findRun(childKey(id)))!;
    return { state: state.state, step: run.currentStep, started: flow().launched.includes(childKey(id)) };
  };

  return {
    runs,
    documents,
    bare,
    treeOf,
    childKey,
    seedEpic,
    seedBacklog,
    commitIn,
    landOnMain,
    backlogPass,
    settleAll,
    block,
    isIn,
    notes,
    stateOf,
    ask,
    handUpQuestion,
    waitingKept,
  };
}
