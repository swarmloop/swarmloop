import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import type { StepName } from '../contract/steps';
import { readDefaultSettings } from '../config/load-env';
import { DiskGuard } from '../pipeline/disk-guard';
import { CommandService } from '../pipeline/command.service';
import { PERSON_RESUME } from '../pipeline/resume-sender';
import * as delays from '../core/delay';
import { Reconciler } from '../pipeline/reconciler';
import { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import { RunHosts } from '../integrations/code-host/run-hosts';
import type { CodeHost } from '../integrations/code-host/code-host';
import { AgentCallRepository } from '../history/agent-call.repository';
import { seedCall } from '../history/agent-call.spec-helpers';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { UserSettingRepository } from '../history/user-setting.repository';
import { BacklogStart } from '../api/backlog-start';
import { RunCommandsService } from '../api/run-commands.service';
import { BacklogActions } from '../pipeline/backlog/backlog-actions';
import { BacklogScheduler } from '../pipeline/backlog/backlog-scheduler';
import { BacklogPlanner } from '../pipeline/backlog/planner/backlog-planner';
import { BacklogStartPort } from '../pipeline/backlog/backlog-start-port';
import type { RunEntity } from '../history/entities';
import { putStamped } from '../steps/shared/gate.spec-helpers';
import { SubtaskOps } from '../steps/shared/subtask-ops';
import { FakeCodeHost } from './fake-code-host';
import type { FakeHostSettings } from './fake-host-rules';
import { FakeSandbox, holdDetachedStarts } from './fake-runtime';
import { featureWorktree, git, remember } from './runs.spec-helpers';
import { BlockAgentRunner } from './result-answer';
import { createTestApp, type FakeAgentRunner, type TestApp } from './test-app';

const REPO = 'demo';
const PROJECT = 'group/demo';
const ORIGIN = `https://gitlab.example/${PROJECT}.git`;
/** The shipped `RECONCILE_MS`, which the test env keeps. */
const RECONCILE_MS = Number(readDefaultSettings().RECONCILE_MS);

/**
 * A fake agent whose conflict launches (the implement step's agent, given a rebase conflict) run `onConflict` on the
 * prompt, as the agent edits the worktree. Every other launch is answered as `BlockAgentRunner` answers it.
 */
export class ConflictAgent extends BlockAgentRunner {
  constructor(
    private readonly onConflict: (prompt: string) => void,
    scripts: ConstructorParameters<typeof BlockAgentRunner>[0] = {},
  ) {
    super(scripts);
  }

  /** The prompts of the conflict launches, in order. */
  get conflicts(): string[] {
    return this.prompts.filter((launch) => launch.step === 'rebase').map((launch) => launch.prompt);
  }

  override run(input: Parameters<BlockAgentRunner['run']>[0]): ReturnType<BlockAgentRunner['run']> {
    const answered = super.run(input);
    if (this.steps.at(-1) === 'rebase') this.onConflict(input.prompt ?? '');
    return answered;
  }
}

/** One whole-flow world: the real pipeline driver and reconciler on a fake code host, a fake sandbox and a fake clock. */
interface FlowHarness {
  app: TestApp;
  /** The worktree of the feature branch, pushed to the bare origin. */
  tree: string;
  host: FakeCodeHost;
  sandbox: FakeSandbox;
  /** The keys of the subtask runs the parent asked to start, in order. */
  launched: string[];
  /** Begins the run at `step` on the fake gitlab host, with what the real merge-request and pipeline steps read: the origin is a gitlab url, and the worktree head is the commit CI is asked about. At `plan` no work exists yet, so there is no implementation and no gate. */
  begin(step: 'plan' | 'merge-request' | 'pipeline', options?: { spentUsd?: number }): Promise<RunEntity>;
  /** A new commit on the feature branch, pushed; the run's pipeline ref and review report stand for it. Returns its sha. */
  recommit(): Promise<string>;
  /** One reconciler pass: the fake clock moves by the reconcile interval, then every pass of a tick runs. */
  tick(): Promise<void>;
  /** The backlog services of the booted app, with the start of a task's run and the code host reaching the fake. */
  backlog(): { actions: BacklogActions; scheduler: BacklogScheduler };
  /** The server stops and starts again on the same root and database. The host and sandbox stay. */
  restart(): Promise<void>;
  /** The free bytes the real disk guard reads, until the next call. */
  diskFree(bytes: number): void;
  /** A person's Resume through the real command path; resolves when the run it started has settled. */
  person(action: 'resume'): Promise<void>;
  /** A person changes a setting and the server starts again with it, on the same root and database. */
  setEnv(name: string, value: string): Promise<void>;
  /** The waits of the steps take no wall time: each one moves the fake clock by its length. Restore with `jest.restoreAllMocks()`. */
  fastWaits(): void;
  /** Docker does not answer for `ms` of fake time; `tick()` moves that time. */
  dockerSilent(ms: number): void;
  close(): Promise<void>;
}

/** The runner of `blocks`, with a changed file in the run's worktree at each implement launch, as an agent leaves its work. */
function changing(blocks: BlockAgentRunner, root: () => string): BlockAgentRunner {
  const run = blocks.run.bind(blocks);
  let changes = 0;
  blocks.run = (input) => {
    if (input.step === 'implement' && input.runKey) {
      writeFileSync(join(root(), 'worktrees', input.runKey, REPO, `fix-${(changes += 1)}.txt`), 'fixed\n');
    }
    return run(input);
  };
  return blocks;
}

/**
 * With `realHost` the merge-request and pipeline steps are the real ones on the fake host, and `begin` is for them.
 * Task runs have no worktree unless `taskWorktrees` says the spec makes them; without them every task is answered as on top of the feature branch.
 */
export async function createFlowHarness(
  key: string,
  options: {
    realHost?: boolean;
    /** Every run takes the real implement and implement-improve steps. */
    realImplement?: boolean | 'all';
    /** Every run takes the real code-review step. */
    realReview?: boolean;
    /** These steps are the real ones. */
    realSteps?: StepName[];
    taskWorktrees?: boolean;
    /**
     * Files of the repository, by path (`.swarmloop.json`, a commitlint config, a merge request template, a
     * devcontainer): written, committed and pushed on the feature branch before the run begins.
     */
    repoFiles?: Record<string, string>;
    /** What the fake code host allows and answers; a default boot sets nothing. */
    fakeHost?: FakeHostSettings;
    env?: Record<string, string>;
    blocks?: BlockAgentRunner;
    /** Every implement launch changes a file in the run's worktree, as an agent that fixes a finding does, and the work stays uncommitted, as the commit step runs after review: the review sees a new tree. Without it the tree stays. */
    implementCommits?: boolean;
    /** The agent process of every real step's launch. */
    runner?: FakeAgentRunner;
    /** Calls of the fake sandbox on top of its own, for a spec whose project has an image. */
    sandboxCalls?: Record<string, (...args: never[]) => Promise<unknown>>;
  } = {},
): Promise<FlowHarness> {
  const sandbox = new FakeSandbox();
  const env = { ...options.env };
  const feature = `feature/${key}-ship-the-field`;
  let rootOf = '';
  const blocks = options.implementCommits && options.blocks ? changing(options.blocks, () => rootOf) : options.blocks;
  const first = await createTestApp({
    realImplement: options.realImplement ?? 'all',
    realHost: options.realHost,
    realReview: options.realReview,
    realSteps: options.realSteps,
    blocks,
    runner: options.runner,
    env,
    sandbox: { ...sandbox.calls, ...options.sandboxCalls },
  });
  rootOf = first.root;
  const { tree, clone } = featureWorktree(first.root, key, REPO);
  git(tree, ['push', 'origin', feature]);
  const host = new FakeCodeHost(clone, feature, () => harness.app.clock.now());
  if (options.repoFiles) commitFiles(tree, options.repoFiles, feature);
  if (options.fakeHost) host.configure(options.fakeHost);

  let diskBytes: number | null = null;
  let backlogWired = false;
  const harness: FlowHarness = {
    app: first,
    tree,
    host,
    sandbox,
    launched: [],
    begin: async (step, begun = {}) => {
      useGitlabOrigin(first.root, tree);
      const { app } = harness;
      await remember(app.app.get(RunRepository), app.app.get(DocumentRepository), key, step, 'waiting');
      const run = await app.app.get(RunRepository).change(key, (row) => {
        row.codeHost = 'gitlab';
      });
      if (begun.spentUsd) await seedCall(app.app.get(AgentCallRepository), { runKey: key, usd: begun.spentUsd });
      if (step === 'plan') return run;
      if (step === 'merge-request') {
        mkdirSync(join(tree, 'src'), { recursive: true });
        writeFileSync(join(tree, 'src', 'feature.ts'), 'export const feature = 1;\n');
        git(tree, ['add', 'src/feature.ts']);
        git(tree, ['commit', '--allow-empty', '-m', 'feat: ship the field']);
        git(tree, ['push', 'origin', feature]);
      }
      await app.app.get(DocumentRepository).putDocument(run, 'implementation', '- shipped the field\n');
      await seedGates(harness, run, feature);
      return run;
    },
    recommit: async () => {
      const { app } = harness;
      const run = (await app.app.get(RunRepository).findRun(key))!;
      writeFileSync(join(tree, 'src', 'readme.ts'), `export const readme = ${app.clock.now()};\n`);
      git(tree, ['commit', '-am', 'fix: the pipeline']);
      git(tree, ['push', 'origin', feature]);
      await seedGates(harness, run, feature);
      return git(tree, ['rev-parse', 'HEAD']);
    },
    tick: async () => {
      harness.app.clock.advance(RECONCILE_MS);
      sandbox.elapse(RECONCILE_MS);
      const reconciler = harness.app.app.get(Reconciler);
      await reconciler.reconcileRuns();
      await reconciler.settleEndedRelaunches();
      await reconciler.resumeOutsideWaits();
      await reconciler.resumeSubtaskParents();
      await reconciler.watchMerges();
      await reconciler.reconcileCommands();
      await harness.app.app.get(BacklogPlanner).whenIdle();
    },
    backlog: () => {
      backlogWired = true;
      wireBacklog(harness);
      return { actions: harness.app.app.get(BacklogActions), scheduler: harness.app.app.get(BacklogScheduler) };
    },
    restart: async () => {
      const before = harness.app.clock.now();
      harness.app = await harness.app.restart();
      harness.app.clock.advance(before - harness.app.clock.now());
      wire(harness, key, options.taskWorktrees);
      if (backlogWired) wireBacklog(harness);
      if (diskBytes !== null) useDisk(harness, diskBytes);
    },
    dockerSilent: (ms) => sandbox.goSilent(ms),
    diskFree: (bytes) => {
      diskBytes = bytes;
      useDisk(harness, bytes);
    },
    person: async (action) => {
      await harness.app.app.get(CommandService).submit(action, key, { ...PERSON_RESUME });
      await harness.app.pipeline.whenIdle(key);
    },
    setEnv: async (name, value) => {
      env[name] = value;
      await harness.restart();
    },
    fastWaits: () => {
      jest.spyOn(delays, 'delay').mockImplementation((ms) => {
        harness.app.clock.advance(ms);
        return Promise.resolve();
      });
    },
    close: () => harness.app.close(),
  };
  wire(harness, key, options.taskWorktrees);
  return harness;
}

/** The files appear in the worktree, in one commit on the feature branch, pushed. */
function commitFiles(tree: string, files: Record<string, string>, feature: string): void {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(tree, path)), { recursive: true });
    writeFileSync(join(tree, path), content);
    git(tree, ['add', path]);
  }
  git(tree, ['commit', '-m', 'chore: add the repository files']);
  git(tree, ['push', 'origin', feature]);
}

function useDisk(harness: FlowHarness, bytes: number): void {
  harness.app.app.get(DiskGuard).useFreeBytes(() => Promise.resolve(bytes));
}

function wire(harness: FlowHarness, key: string, taskWorktrees = false): void {
  if (!taskWorktrees) jest.spyOn(harness.app.app.get(SubtaskOps), 'behindTip').mockResolvedValue(null);
  const registry = harness.app.app.get(CodeHostRegistry);
  jest.spyOn(RunHosts.prototype, 'byName').mockReturnValue(harness.host as unknown as CodeHost);
  // The fake host stands for the door, so a run needs no real token in the environment.
  jest.spyOn(RunHosts.prototype, 'requiredCredentials').mockReturnValue(harness.host.selected());
  // A fetch of the server names the url with the token, which `useGitlabOrigin` maps to the local bare repository.
  jest
    .spyOn(registry, 'tokensFor')
    .mockResolvedValue({ GITLAB_BASE_URL: 'https://gitlab.example', GITLAB_TOKEN: 'token' });
  holdDetachedStarts(harness.app.pipeline, key, harness.launched);
}

/** The app starts a backlog task as the API does, and every code host lookup of the backlog layer reaches the fake host. */
function wireBacklog(harness: FlowHarness): void {
  const { app } = harness.app;
  new BacklogStart(
    app.get(BacklogStartPort),
    app.get(RunCommandsService),
    app.get(CommandService),
    app.get(UserSettingRepository),
  ).onModuleInit();
  const registry = app.get(CodeHostRegistry);
  jest.spyOn(registry, 'forRun').mockReturnValue(registry.forRun(null));
  jest.spyOn(RunHosts.prototype, 'forOrigin').mockReturnValue(harness.host.name);
}

/**
 * The origin becomes a gitlab url, which `remoteProject` parses. A push still reaches the local bare repository through
 * `pushInsteadOf`; `insteadOf` on the plain url would show the bare path in `remote get-url`, so it names only the url with the token.
 */
export function useGitlabOrigin(root: string, tree: string): void {
  const bare = join(root, `${REPO}.git`);
  git(tree, ['remote', 'set-url', 'origin', ORIGIN]);
  git(tree, ['config', '--add', `url.${bare}.pushInsteadOf`, ORIGIN]);
  const withToken = ORIGIN.replace('https://', 'https://oauth2:token@');
  git(tree, ['config', '--add', `url.${bare}.pushInsteadOf`, withToken]);
  // A fetch names the url with the token, never `origin`, so only that url reaches the bare repository.
  git(tree, ['config', '--add', `url.${bare}.insteadOf`, withToken]);
}

/** The pipeline ref of the worktree head and the review report, stamped for the worktree as the steps before them leave them. */
async function seedGates(harness: FlowHarness, run: RunEntity, feature: string): Promise<void> {
  const sha = git(harness.tree, ['rev-parse', 'HEAD']);
  const ref = `project: ${PROJECT}\nref: ${feature}\nsha: ${sha}\n`;
  await putStamped(harness.app.app, run, 'pipeline_ref', ref, [REPO]);
  await putStamped(harness.app.app, run, 'review_report', '- the field ships\n', [REPO]);
}
