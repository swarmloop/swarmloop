import 'reflect-metadata';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { readDefaultSettings } from '../config/load-env';
import { DiskGuard } from '../pipeline/disk-guard';
import { CommandService } from '../pipeline/command.service';
import * as delays from '../core/delay';
import { Reconciler } from '../pipeline/reconciler';
import { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import type { CodeHost } from '../integrations/code-host/code-host';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import type { RunEntity } from '../history/entities';
import { putStamped } from '../steps/shared/gate.spec-helpers';
import { SubtaskOps } from '../steps/shared/subtask-ops';
import { FakeCodeHost } from './fake-code-host';
import { FakeSandbox, holdDetachedStarts } from './fake-runtime';
import { featureWorktree, git, remember } from './runs.spec-helpers';
import type { BlockAgentRunner } from './result-answer';
import { createTestApp, type TestApp } from './test-app';

const REPO = 'demo';
const PROJECT = 'group/demo';
const ORIGIN = `https://gitlab.example/${PROJECT}.git`;
/** The shipped `RECONCILE_MS`, which the test env keeps. */
const RECONCILE_MS = Number(readDefaultSettings().RECONCILE_MS);

/** One whole-flow world: the real pipeline driver and reconciler on a fake code host, a fake sandbox and a fake clock. */
interface FlowHarness {
  app: TestApp;
  /** The worktree of the feature branch, pushed to the bare origin. */
  tree: string;
  host: FakeCodeHost;
  sandbox: FakeSandbox;
  /** The keys of the subtask runs the parent asked to start, in order. */
  launched: string[];
  /** Begins the run at `step` on the fake gitlab host, with what the real merge-request and pipeline steps read: the origin is a gitlab url, and the worktree head is the commit CI is asked about. */
  begin(step: 'merge-request' | 'pipeline', options?: { spentUsd?: number }): Promise<RunEntity>;
  /** A new commit on the feature branch, pushed; the run's pipeline ref and review report stand for it. Returns its sha. */
  recommit(): Promise<string>;
  /** One reconciler pass: the fake clock moves by the reconcile interval, then every pass of a tick runs. */
  tick(): Promise<void>;
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
    taskWorktrees?: boolean;
    env?: Record<string, string>;
    blocks?: BlockAgentRunner;
  } = {},
): Promise<FlowHarness> {
  const sandbox = new FakeSandbox();
  const env = { ...options.env };
  const feature = `feature/${key}-ship-the-field`;
  const first = await createTestApp({
    realImplement: options.realImplement ?? 'all',
    realHost: options.realHost,
    realReview: options.realReview,
    blocks: options.blocks,
    env,
    sandbox: sandbox.calls,
  });
  const { tree, clone } = featureWorktree(first.root, key, REPO);
  git(tree, ['push', 'origin', feature]);
  const host = new FakeCodeHost(clone, feature, () => harness.app.clock.now());

  let diskBytes: number | null = null;
  const harness: FlowHarness = {
    app: first,
    tree,
    host,
    sandbox,
    launched: [],
    begin: async (step, begun = {}) => {
      useGitlabOrigin(first.root, tree);
      const { app } = harness;
      const run = await remember(app.app.get(RunRepository), app.app.get(DocumentRepository), key, step, 'waiting');
      run.codeHost = 'gitlab';
      run.spentUsd = begun.spentUsd ?? run.spentUsd;
      await app.app.get(RunRepository).saveRun(run);
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
      await reconciler.resumeLimited();
      await reconciler.resumeHostUnavailable();
      await reconciler.resumeCiNotStarted();
      await reconciler.resumeDocker();
      await reconciler.resumeDiskLow();
      await reconciler.resumeGitAuth();
      await reconciler.resumeSubtaskParents();
      await reconciler.watchMerges();
      await reconciler.reconcileCommands();
    },
    restart: async () => {
      const before = harness.app.clock.now();
      harness.app = await harness.app.restart();
      harness.app.clock.advance(before - harness.app.clock.now());
      wire(harness, key, options.taskWorktrees);
      if (diskBytes !== null) useDisk(harness, diskBytes);
    },
    dockerSilent: (ms) => sandbox.goSilent(ms),
    diskFree: (bytes) => {
      diskBytes = bytes;
      useDisk(harness, bytes);
    },
    person: async (action) => {
      await harness.app.app.get(CommandService).submit(action, key, {});
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

function useDisk(harness: FlowHarness, bytes: number): void {
  harness.app.app.get(DiskGuard).useFreeBytes(() => Promise.resolve(bytes));
}

function wire(harness: FlowHarness, key: string, taskWorktrees = false): void {
  if (!taskWorktrees) jest.spyOn(harness.app.app.get(SubtaskOps), 'behindTip').mockResolvedValue(null);
  jest.spyOn(harness.app.app.get(CodeHostRegistry), 'byName').mockReturnValue(harness.host as unknown as CodeHost);
  holdDetachedStarts(harness.app.pipeline, key, harness.launched);
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
