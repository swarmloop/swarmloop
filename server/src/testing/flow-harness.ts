import 'reflect-metadata';
import { chmodSync, writeFileSync } from 'fs';
import { join } from 'path';
import { Reconciler } from '../pipeline/reconciler';
import { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import type { CodeHost } from '../integrations/code-host/code-host';
import { FakeCodeHost } from './fake-code-host';
import { FakeSandbox, holdDetachedStarts } from './fake-runtime';
import { featureWorktree, git } from './runs.spec-helpers';
import { createTestApp, type TestApp } from './test-app';

const REPO = 'demo';
/** The default of `RECONCILE_MS`, which the test env keeps. */
const RECONCILE_MS = 60_000;

/** One whole-flow world: the real pipeline driver and reconciler on a fake code host, a fake sandbox and a fake clock. */
interface FlowHarness {
  app: TestApp;
  /** The worktree of the feature branch, pushed to the bare origin. */
  tree: string;
  host: FakeCodeHost;
  sandbox: FakeSandbox;
  /** The keys of the subtask runs the parent asked to start, in order. */
  launched: string[];
  /** One reconciler pass: the fake clock moves by the reconcile interval, then every pass of a tick runs. */
  tick(): Promise<void>;
  /** The server stops and starts again on the same root and database. The host and sandbox stay. */
  restart(): Promise<void>;
  /** Docker does not answer for `ms` of fake time; `tick()` moves that time. */
  dockerSilent(ms: number): void;
  /** The next push to the origin fails once on a 502; later pushes go through. */
  failNextPush(): void;
  close(): Promise<void>;
}

export async function createFlowHarness(key: string): Promise<FlowHarness> {
  const sandbox = new FakeSandbox();
  const feature = `feature/${key}-ship-the-field`;
  const first = await createTestApp({ realImplement: true, sandbox: sandbox.calls });
  const { tree, clone } = featureWorktree(first.root, key, REPO);
  git(tree, ['push', 'origin', feature]);
  const host = new FakeCodeHost(clone, feature);

  const harness: FlowHarness = {
    app: first,
    tree,
    host,
    sandbox,
    launched: [],
    tick: async () => {
      harness.app.clock.advance(RECONCILE_MS);
      sandbox.elapse(RECONCILE_MS);
      const reconciler = harness.app.app.get(Reconciler);
      await reconciler.reconcileRuns();
      await reconciler.resumeLimited();
      await reconciler.resumeGitAuth();
      await reconciler.resumeSubtaskParents();
      await reconciler.watchMerges();
      await reconciler.reconcileCommands();
    },
    restart: async () => {
      const before = harness.app.clock.now();
      harness.app = await harness.app.restart();
      harness.app.clock.advance(before - harness.app.clock.now());
      wire(harness, key);
    },
    dockerSilent: (ms) => sandbox.goSilent(ms),
    failNextPush: () => failOnce(join(first.root, `${REPO}.git`)),
    close: () => harness.app.close(),
  };
  wire(harness, key);
  return harness;
}

function wire(harness: FlowHarness, key: string): void {
  jest.spyOn(harness.app.app.get(CodeHostRegistry), 'byName').mockReturnValue(harness.host as unknown as CodeHost);
  holdDetachedStarts(harness.app.pipeline, key, harness.launched);
}

/** A pre-receive hook that refuses the first push the way a host answers a 502, then lets pushes through. */
function failOnce(bare: string): void {
  const hook = join(bare, 'hooks', 'pre-receive');
  const marker = join(bare, 'push-failed-once');
  writeFileSync(
    hook,
    `#!/bin/sh\nif [ ! -e "${marker}" ]; then touch "${marker}"; echo "The requested URL returned error: 502" >&2; exit 1; fi\n`,
  );
  chmodSync(hook, 0o755);
}
