import { storeRun } from '../../testing/store-run.spec-helpers';
import { parseSubtasks, type Subtask } from '../../contract/subtask';
import type { StepOptions } from '../../core/pipeline-result';
import { FetchFailed, MergeConflict } from '../../core/swarmloop-error';
import { RunHosts } from '../../integrations/code-host/run-hosts';
import type { CodeHost } from '../../integrations/code-host/code-host';
import { renderMergeRequest } from '../merge-request/merge-request-record';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { storedState, writeRunState } from '../../history/run-state';
import { CommandService } from '../../pipeline/command.service';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { SubtaskOps } from '../shared/subtask-ops';
import { featureWorktree, git, save } from '../../testing/runs.spec-helpers';

export const KEY = 'PROJ-300';

export const task = (id: string, depends: string[] = []): Subtask => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  depends,
  files: [`src/${id}.ts`],
  proof: `${id}.spec.ts`,
  status: 'waiting',
});

export const requirements = `${JSON.stringify({
  prompt: 'Ship the field\n',
  tickets: [{ key: KEY, summary: 'Ship the field' }],
  plan: { name: 'plan', overview: '', items: ['do it'], decision: 'approve' },
})}\n`;

/** An app with the real implement step. Starting a subtask run is recorded, not run. The runs have no worktree, so every task is answered as on top of the feature branch; the merge queue has its own whole-flow spec. */
export async function world(env: Record<string, string> = {}) {
  const app = await createTestApp({
    realImplement: true,
    realReview: false,
    env,
    sandbox: { stopRun: () => Promise.resolve('gone') },
  });
  jest.spyOn(app.app.get(SubtaskOps), 'behindTip').mockResolvedValue(null);
  jest.spyOn(app.app.get(SubtaskOps), 'moving').mockResolvedValue(false);
  return { app, ...instrument(app) };
}

function instrument(app: TestApp) {
  const launched: string[] = [];
  const original = app.pipeline.startDetached.bind(app.pipeline);
  jest.spyOn(app.pipeline, 'startDetached').mockImplementation((key, ...rest) => {
    if (key === KEY) return original(key, ...rest);
    launched.push(key);
    return Promise.resolve({ exitCode: 0, message: `${key} started` });
  });
  return { launched };
}

export async function seedParent(app: TestApp, tasks: Subtask[]) {
  const runs = app.app.get(RunRepository);
  const parent = await save(runs, KEY, 'implement', 'waiting');
  parent.split = true;
  parent.projects = 'demo\n';
  await storeRun(runs, parent);
  const documents = app.app.get(DocumentRepository);
  await documents.putDocument(parent, 'requirements', requirements);
  await documents.putDocument(parent, 'subtasks', `${JSON.stringify(tasks)}\n`);
  return parent;
}

export async function pass(app: TestApp, options: StepOptions = {}) {
  return app.pipeline.step('implement', KEY, options);
}

/** Waits for the commands accepted so far and for the pass they started. */
export async function settle(app: TestApp): Promise<void> {
  await app.app.get(CommandService).idle();
  await app.pipeline.whenIdle(KEY);
}

export async function tasksOf(app: TestApp): Promise<Subtask[]> {
  return parseSubtasks(await app.app.get(DocumentRepository).latestBody(KEY, 'subtasks'));
}

export const statuses = async (app: TestApp) =>
  Object.fromEntries((await tasksOf(app)).map((item) => [item.id, item.status]));

export async function setStatus(app: TestApp, id: string, status: Subtask['status']): Promise<void> {
  const parent = (await app.app.get(RunRepository).findRun(KEY))!;
  const tasks = (await tasksOf(app)).map((item) => (item.id === id ? { ...item, status } : item));
  await app.app.get(DocumentRepository).putDocument(parent, 'subtasks', `${JSON.stringify(tasks)}\n`);
}

export async function child(app: TestApp, id: string) {
  return (await app.app.get(RunRepository).findRun(`${KEY}-${id}`))!;
}

/** The subtask run works: its owner is alive. */
export async function work(app: TestApp, id: string): Promise<void> {
  const run = await child(app, id);
  writeRunState(run, { status: 'running', currentStep: 'research', ownerPid: process.pid });
  await storeRun(app.app.get(RunRepository), run);
}

export async function finish(app: TestApp, id: string): Promise<void> {
  const run = await child(app, id);
  writeRunState(run, { status: 'done', currentStep: 'done' });
  await storeRun(app.app.get(RunRepository), run);
}

export async function parentState(app: TestApp) {
  return storedState((await app.app.get(RunRepository).findRun(KEY))!);
}

export const FEATURE = 'feature/PROJ-300-ship-the-field';

/** A code host whose merge adds one commit to the feature branch of a real origin. */
export class FakeHost {
  readonly merges: number[] = [];
  readonly closed: number[] = [];
  readonly deleted: string[] = [];
  readonly targets = new Map<number, string>();
  readonly merged = new Map<number, string>();
  readonly conflicts = new Set<number>();
  /** The head each merge was guarded by, by request. */
  readonly guards = new Map<number, string | undefined>();
  /** The requests that are drafts, and those whose head has a failing check. */
  readonly drafts = new Set<number>();
  readonly failing = new Set<number>();
  crashOn: number | null = null;
  refusal: string | null = null;
  failClose = false;

  constructor(private readonly clone: string) {}

  readMergeRequest(_project: string, iid: number) {
    const sha = this.merged.get(iid) ?? null;
    return Promise.resolve({ state: sha ? 'merged' : 'open', sha, conflicts: this.conflicts.has(iid), httpCalls: [] });
  }

  /** The head commit of a request, as the gate and the pipeline of the host name it. */
  static headOf(iid: number): string {
    return `head-${iid}`;
  }

  readMergeGate(_project: string, iid: number) {
    const sha = this.merged.get(iid) ?? null;
    return Promise.resolve({
      state: sha ? 'merged' : 'open',
      sha,
      draft: this.drafts.has(iid),
      head: FakeHost.headOf(iid),
      mergeability: this.conflicts.has(iid) ? 'conflicting' : 'clean',
      blockedBy: null,
      httpCalls: [],
    });
  }

  readBranchPipeline(ref: { sha?: string }) {
    const failed = [...this.failing].some((iid) => FakeHost.headOf(iid) === ref.sha);
    const checks = failed
      ? [
          {
            id: 1,
            name: 'test',
            app: '',
            status: 'failed',
            durationMs: 1,
            url: '',
            summary: '',
            annotations: [],
            workflow: true,
          },
        ]
      : [];
    const snapshot = {
      id: 1,
      status: failed ? 'failed' : 'success',
      url: '',
      jobs: [],
      runs: [],
      checks,
      awaiting: [],
    };
    return Promise.resolve({ snapshot, httpCalls: [] });
  }

  readMergeMethods() {
    return Promise.resolve({ methods: ['squash'], httpCalls: [] });
  }

  mergeMergeRequest(_project: string, iid: number, guard?: string) {
    this.guards.set(iid, guard);
    if (this.targets.get(iid) !== FEATURE) return Promise.reject(new Error(`!${iid} does not target ${FEATURE}`));
    if (iid === this.crashOn) return Promise.reject(new Error('crash'));
    if (this.refusal) return Promise.reject(new FetchFailed(this.refusal));
    if (this.conflicts.has(iid)) return Promise.reject(new MergeConflict('Pull Request is not mergeable'));
    git(this.clone, ['fetch', 'origin']);
    const tip = git(this.clone, ['rev-parse', `origin/${FEATURE}`]);
    const tree = git(this.clone, ['rev-parse', `${tip}^{tree}`]);
    const sha = git(this.clone, ['commit-tree', tree, '-p', tip, '-m', `squash !${iid}`]);
    git(this.clone, ['push', 'origin', `${sha}:refs/heads/${FEATURE}`]);
    this.merged.set(iid, sha);
    this.merges.push(iid);
    return Promise.resolve({ sha, httpCalls: [] });
  }

  closeMergeRequest(_project: string, iid: number) {
    if (this.failClose) return Promise.reject(new Error('close refused'));
    this.closed.push(iid);
    return Promise.resolve({ httpCalls: [] });
  }

  deleteBranch(_project: string, branch: string) {
    this.deleted.push(branch);
    return Promise.resolve({ httpCalls: [] });
  }
}

/** The origin and the parent worktree on the feature branch, and a host that merges into that origin. */
export async function mergeWorld() {
  const built = await world();
  const { tree, clone } = featureWorktree(built.app.root, KEY);
  git(tree, ['push', 'origin', FEATURE]);
  const host = new FakeHost(clone);
  jest.spyOn(RunHosts.prototype, 'byName').mockReturnValue(host as unknown as CodeHost);
  jest.spyOn(RunHosts.prototype, 'requiredCredentials').mockReturnValue({} as never);
  const rebased: string[] = [];
  const commands = built.app.app.get(CommandService);
  const accept = commands.accept.bind(commands);
  jest.spyOn(commands, 'accept').mockImplementation((type, key, payload, options) => {
    if (type !== 'rebase') return accept(type, key, payload, options);
    rebased.push(key);
    return Promise.resolve({}) as ReturnType<typeof accept>;
  });
  return { ...built, tree, host, rebased };
}

/** The merge requests a subtask run opened, one per repository, as `repo: iid`. */
export async function opened(app: TestApp, host: FakeHost, id: string, requests: Record<string, number>) {
  const run = await child(app, id);
  const documents = app.app.get(DocumentRepository);
  await documents.putDocument(run, 'requirements', requirements);
  await documents.putDocument(run, 'repos', `${Object.keys(requests).join('\n')}\n`);
  const records = Object.entries(requests).map(([repo, iid]) => ({
    project: repo,
    iid,
    url: `https://code.example/${repo}/${iid}`,
    draft: false,
    summary: '',
  }));
  await documents.putDocument(run, 'merge_request', renderMergeRequest(records));
  records.forEach((record) => host.targets.set(record.iid, FEATURE));
}

export async function seedMergeParent(app: TestApp, tasks: Subtask[]) {
  const parent = await seedParent(app, tasks);
  parent.codeHost = 'github';
  await storeRun(app.app.get(RunRepository), parent);
  await app.app.get(DocumentRepository).putDocument(parent, 'repos', 'demo\n');
  await pass(app);
  return parent;
}
