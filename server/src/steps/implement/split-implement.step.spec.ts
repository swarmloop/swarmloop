import 'reflect-metadata';
import { resultAnswer } from '../../testing/result-answer';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { getRepositoryToken } from '@nestjs/typeorm';
import type { Repository } from 'typeorm';
import { AGENT_RUNNER, type AgentRunInput, type AgentRunResult } from '../../agent/agent-runner';
import { agentFor } from '../../config/agents';
import { AppConfig } from '../../config/env';
import { VisitRepository } from '../../history/visit.repository';
import { agentStateDir } from '../../sandbox/sandbox-launch';
import { RunCommandsService } from '../../api/run-commands.service';
import { ERROR_CODES } from '../../contract/error-codes';
import { type Subtask } from '../../contract/subtask';
import { DocumentEntity } from '../../history/entities';
import { DocumentRepository } from '../../history/document.repository';
import { RunRepository } from '../../history/run.repository';
import { deriveState, writeRunState } from '../../history/run-state';
import { CommandService } from '../../pipeline/command.service';
import { Reconciler } from '../../pipeline/reconciler';
import { SubtaskPort } from '../../pipeline/subtask-port';
import { createTestApp, type TestApp } from '../../testing/test-app';
import { NO_CI_NOTE } from './split-implement.step';
import { FetchFailed, MergeConflict } from '../../core/swarmloop-error';
import { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import type { CodeHost } from '../../integrations/code-host/code-host';
import { renderMergeRequest } from '../merge-request/merge-request-record';
import { featureWorktree, git } from '../../testing/runs.spec-helpers';

import {
  KEY,
  child,
  requirements,
  finish,
  parentState,
  pass,
  seedParent,
  setStatus,
  settle,
  statuses,
  task,
  tasksOf,
  work,
  world,
} from './split-implement.spec-helpers';

describe('split implement', () => {
  let app: TestApp;

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  it('makes a run for every task at once, starts those with no dependency, and holds no claim between passes', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b', ['a']), task('c')]);

    await pass(app);

    const runs = app.app.get(RunRepository);
    const parent = (await runs.findRun(KEY))!;
    expect((await runs.children(parent)).map((run) => run.key)).toEqual([`${KEY}-a`, `${KEY}-b`, `${KEY}-c`]);
    expect(built.launched).toEqual([`${KEY}-a`, `${KEY}-c`]);
    expect(existsSync(join(app.root, 'worktrees', `${KEY}-b`))).toBe(false);
    expect(await statuses(app)).toEqual({ a: 'running', b: 'waiting', c: 'running' });
    expect((await tasksOf(app))[1]?.note).toBe('waiting for a');
    expect(deriveState(await child(app, 'b')).reason).toMatchObject({
      code: ERROR_CODES.SUBTASK_WAITING,
      message: 'waiting for a',
    });
    expect(parent).toMatchObject({ status: 'waiting', ownerPid: null, activeAttempt: null });
    expect(runs.held(parent)).toBe(false);
    expect((await parentState(app)).reason).toMatchObject({ code: ERROR_CODES.SUBTASKS_RUNNING });
  });

  it('runs at most SUBTASKS_PARALLEL tasks at once', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b'), task('c'), task('d')]);

    await pass(app);
    expect(built.launched).toHaveLength(3);
    expect(await statuses(app)).toEqual({ a: 'running', b: 'running', c: 'running', d: 'waiting' });

    await setStatus(app, 'a', 'merged');
    await pass(app);
    expect(built.launched).toHaveLength(4);
    expect(await statuses(app)).toMatchObject({ a: 'merged', d: 'running' });
  });

  it('starts a task only when its dependencies are merged or skipped', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b', ['a']), task('c', ['b'])]);

    await pass(app);
    expect(built.launched).toEqual([`${KEY}-a`]);

    await finish(app, 'a');
    await pass(app);
    expect(await statuses(app)).toEqual({ a: 'green', b: 'waiting', c: 'waiting' });
    expect(built.launched).toEqual([`${KEY}-a`]);

    await setStatus(app, 'a', 'merged');
    await pass(app);
    expect(built.launched).toEqual([`${KEY}-a`, `${KEY}-b`]);
    expect(await statuses(app)).toEqual({ a: 'merged', b: 'running', c: 'waiting' });
  });

  it('changes nothing when a pass runs twice in a row', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b', ['a'])]);
    const documents = app.app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
    const stored = () => documents.count({ where: { kind: 'subtasks' } });

    await pass(app);
    const body = await app.app.get(DocumentRepository).latestBody(KEY, 'subtasks');
    const count = await stored();
    const children = (await app.app.get(RunRepository).listRuns()).length;

    await pass(app);

    expect(await app.app.get(DocumentRepository).latestBody(KEY, 'subtasks')).toBe(body);
    expect(await stored()).toBe(count);
    expect((await app.app.get(RunRepository).listRuns()).length).toBe(children);
    expect(built.launched).toEqual([`${KEY}-a`]);
  });

  it('starts a pass through the command door when a subtask run ends', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b', ['a'])]);
    await pass(app);

    // The subtask run goes through its steps and ends done; the parent hears of it and runs a pass.
    await app.pipeline.runThrough(`${KEY}-a`);
    await settle(app);

    expect(await statuses(app)).toEqual({ a: 'green', b: 'waiting' });
    expect((await parentState(app)).state).toBe('waiting');
  });

  it('records no CI on the feature branch for a green subtask whose merge request had no pipeline', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a')]);
    await pass(app);
    await finish(app, 'a');
    await app.app
      .get(DocumentRepository)
      .putDocument(await child(app, 'a'), 'pipeline_log', 'result: none\nnothing started\nproject: demo\n');

    await pass(app);

    expect((await tasksOf(app))[0]).toMatchObject({ status: 'green', note: NO_CI_NOTE });
  });

  it('marks a task skipped with the note when its run ended with the behavior already delivered, and its dependent starts', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b', ['a'])]);
    await pass(app);
    await finish(app, 'a');
    await app.app.get(DocumentRepository).putDocument(await child(app, 'a'), 'commit', 'already delivered: src/a.ts\n');

    await pass(app);

    expect(await tasksOf(app)).toMatchObject([
      { id: 'a', status: 'skipped', note: 'already delivered: src/a.ts' },
      { id: 'b', status: 'running' },
    ]);
  });

  it('blocks the parent naming the failed subtask, and Skip task goes on', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b', ['a'])]);
    await pass(app);
    const failed = await child(app, 'a');
    writeRunState(failed, { status: 'blocked', reason: { code: 'BLOCKED', message: 'review kept returning' } });
    await app.app.get(RunRepository).saveRun(failed);

    await pass(app);

    const blocked = await parentState(app);
    expect(blocked.state).toBe('blocked');
    expect(blocked.reason).toMatchObject({ code: ERROR_CODES.SUBTASK_BLOCKED });
    expect(blocked.reason?.message).toContain('subtask a');

    await app.app.get(CommandService).submit('skip', KEY, { taskId: 'a' });
    await settle(app);

    expect(await statuses(app)).toEqual({ a: 'skipped', b: 'running' });
    expect(built.launched).toContain(`${KEY}-b`);
    expect((await parentState(app)).state).toBe('waiting');
  });

  it('stops every subtask and starts none when the parent is stopped, and Resume goes on', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b'), task('c', ['a'])]);
    await pass(app);
    await work(app, 'a');
    await work(app, 'b');

    await app.app.get(CommandService).submit('stop', KEY, {});

    expect((await parentState(app)).state).toBe('stopped');
    expect(deriveState(await child(app, 'a')).state).toBe('stopped');
    expect(deriveState(await child(app, 'b')).state).toBe('stopped');
    await app.app.get(Reconciler).resumeSubtaskParents();
    await settle(app);
    expect(built.launched).toEqual([`${KEY}-a`, `${KEY}-b`]);
    expect((await parentState(app)).state).toBe('stopped');

    await app.app.get(CommandService).submit('resume', KEY, {});
    await settle(app);

    expect(built.launched).toEqual([`${KEY}-a`, `${KEY}-b`, `${KEY}-a`, `${KEY}-b`]);
    expect(await statuses(app)).toEqual({ a: 'running', b: 'running', c: 'waiting' });
    expect((await parentState(app)).state).toBe('waiting');
  });

  it('goes on after a restart', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b', ['a'])]);
    await pass(app);
    await finish(app, 'a');

    app = await app.restart();
    await settle(app);

    expect(await statuses(app)).toEqual({ a: 'green', b: 'waiting' });
  });

  it('is started by the reconciler timer for a parent that waits', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a')]);
    await pass(app);
    await finish(app, 'a');

    await app.app.get(Reconciler).resumeSubtaskParents();
    await settle(app);

    expect(await statuses(app)).toEqual({ a: 'green' });
  });

  it('removes the subtasks of a Replay at plan, and keeps them for a Replay at a later step', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b')]);
    await pass(app);
    jest.spyOn(app.pipeline, 'replay').mockResolvedValue({ exitCode: 0, message: 'started' });
    const runs = app.app.get(RunRepository);
    const commands = app.app.get(CommandService);

    await commands.submit('replay', KEY, { step: 'checks', prompt: 'again' });
    expect(await runs.children((await runs.findRun(KEY))!)).toHaveLength(2);

    await commands.submit('replay', KEY, { step: 'plan', prompt: 'again' });
    expect(await runs.children((await runs.findRun(KEY))!)).toEqual([]);
    expect((await runs.listRuns()).map((run) => run.key)).toEqual([KEY]);
  });

  it('leaves no subtask, row or worktree, behind when the parent is removed', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b')]);
    await pass(app);
    mkdirSync(join(app.root, 'worktrees', `${KEY}-a`, 'demo'), { recursive: true });

    await app.app.get(RunCommandsService).remove(KEY);

    expect(await app.app.get(RunRepository).listRuns()).toEqual([]);
    expect(existsSync(join(app.root, 'worktrees', `${KEY}-a`))).toBe(false);
  });

  it('moves the parent to checks, skipping implement-improve, when every task is merged or skipped', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b', ['a'])]);
    await pass(app);
    await setStatus(app, 'a', 'merged');
    await setStatus(app, 'b', 'skipped');

    await pass(app);

    const parent = (await app.app.get(RunRepository).findRun(KEY))!;
    expect(parent).toMatchObject({ currentStep: 'checks', status: 'waiting' });
    expect(await app.app.get(DocumentRepository).latestBody(KEY, 'implementation')).toContain('Task a (merged)');
    expect(await app.app.get(DocumentRepository).latestBody(KEY, 'implementation_result')).toContain('Task a (merged)');
  });

  it('leaves a settled parent with a rebase conflict to the agent path, not the passes', async () => {
    const built = await world();
    app = built.app;
    const parent = await seedParent(app, [task('a')]);
    await setStatus(app, 'a', 'merged');
    await app.app.get(DocumentRepository).putDocument(parent, 'rebase_conflict', 'pending\n');

    await pass(app);

    expect((await app.app.get(RunRepository).findRun(KEY))?.currentStep).not.toBe('checks');
  });

  it('keeps a parent stopped that a blocked subtask held', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a')]);
    await pass(app);
    const failed = await child(app, 'a');
    writeRunState(failed, { status: 'blocked', reason: { code: 'BLOCKED', message: 'x' } });
    await app.app.get(RunRepository).saveRun(failed);
    await pass(app);
    expect((await parentState(app)).reason?.code).toBe(ERROR_CODES.SUBTASK_BLOCKED);

    await app.app.get(CommandService).submit('stop', KEY, {});
    await app.app.get(Reconciler).resumeSubtaskParents();
    await settle(app);

    expect((await parentState(app)).state).toBe('stopped');
  });
});

const FEATURE = 'feature/PROJ-300-ship-the-field';

/** A code host whose merge adds one commit to the feature branch of a real origin. */
class FakeHost {
  readonly merges: number[] = [];
  readonly closed: number[] = [];
  readonly deleted: string[] = [];
  readonly targets = new Map<number, string>();
  readonly merged = new Map<number, string>();
  readonly conflicts = new Set<number>();
  crashOn: number | null = null;
  refusal: string | null = null;

  constructor(private readonly clone: string) {}

  readMergeRequest(_project: string, iid: number) {
    const sha = this.merged.get(iid) ?? null;
    return Promise.resolve({ state: sha ? 'merged' : 'open', sha, conflicts: this.conflicts.has(iid), httpCalls: [] });
  }

  mergeMergeRequest(_project: string, iid: number) {
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
    this.closed.push(iid);
    return Promise.resolve({ httpCalls: [] });
  }

  deleteBranch(_project: string, branch: string) {
    this.deleted.push(branch);
    return Promise.resolve({ httpCalls: [] });
  }
}

/** The origin and the parent worktree on the feature branch, and a host that merges into that origin. */
async function mergeWorld() {
  const built = await world();
  const { tree, clone } = featureWorktree(built.app.root, KEY);
  git(tree, ['push', 'origin', FEATURE]);
  const host = new FakeHost(clone);
  const registry = built.app.app.get(CodeHostRegistry);
  jest.spyOn(registry, 'byName').mockReturnValue(host as unknown as CodeHost);
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
async function opened(app: TestApp, host: FakeHost, id: string, requests: Record<string, number>) {
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

async function seedMergeParent(app: TestApp, tasks: Subtask[]) {
  const parent = await seedParent(app, tasks);
  parent.codeHost = 'github';
  await app.app.get(RunRepository).saveRun(parent);
  await app.app.get(DocumentRepository).putDocument(parent, 'repos', 'demo\n');
  await pass(app);
  return parent;
}

describe('a new run', () => {
  it('splits through the command door when SPLIT is left at its default', async () => {
    const app = await createTestApp({ env: { SPLIT: 'auto' } });
    try {
      const response = await fetch(`${app.url}/runs`, {
        method: 'POST',
        headers: { ...app.auth, 'content-type': 'application/json' },
        body: JSON.stringify({ key: 'PROJ-301', prompt: 'Ship it', projects: ['demo'] }),
      });
      expect(response.status).toBe(202);
      expect((await app.app.get(RunRepository).findRun('PROJ-301'))?.split).toBe(true);
    } finally {
      await app.close();
    }
  });
});

describe('split merge', () => {
  let app: TestApp;

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  it('merges the green tasks one at a time in task order, into the feature branch only, and moves the parent worktree', async () => {
    const built = await mergeWorld();
    app = built.app;
    await seedMergeParent(app, [task('a'), task('b'), task('c', ['a'])]);
    await opened(app, built.host, 'b', { demo: 2 });
    await opened(app, built.host, 'a', { demo: 1 });
    await finish(app, 'a');
    await finish(app, 'b');

    await pass(app);

    expect(built.host.merges).toEqual([1, 2]);
    expect(built.host.merges.map((iid) => built.host.targets.get(iid))).toEqual([FEATURE, FEATURE]);
    expect(await statuses(app)).toEqual({ a: 'merged', b: 'merged', c: 'running' });
    expect(built.launched).toContain(`${KEY}-c`);
    const tasks = await tasksOf(app);
    expect(tasks[0]?.merged).toEqual({ demo: built.host.merged.get(1) });
    expect(git(built.tree, ['rev-parse', 'HEAD'])).toBe(built.host.merged.get(2));
  });

  it('deletes the branch of a merged subtask', async () => {
    const built = await mergeWorld();
    app = built.app;
    await seedMergeParent(app, [task('a')]);
    await opened(app, built.host, 'a', { demo: 1 });
    await finish(app, 'a');

    await pass(app);

    expect(built.host.deleted).toEqual(['feature/PROJ-300-a-ship-the-field']);
  });

  it('sends a Rebase to a subtask whose merge conflicts, and merges it when it comes back green', async () => {
    const built = await mergeWorld();
    app = built.app;
    await seedMergeParent(app, [task('a')]);
    await opened(app, built.host, 'a', { demo: 1 });
    await finish(app, 'a');
    built.host.conflicts.add(1);

    await pass(app);

    expect(built.rebased).toEqual([`${KEY}-a`]);
    expect(built.host.merges).toEqual([]);
    expect(await statuses(app)).toEqual({ a: 'running' });

    built.host.conflicts.delete(1);
    await pass(app);

    expect(built.host.merges).toEqual([1]);
    expect(await statuses(app)).toEqual({ a: 'merged' });
  });

  it('sends a Rebase to an open subtask whose merge request conflicts after a merge', async () => {
    const built = await mergeWorld();
    app = built.app;
    await seedMergeParent(app, [task('a'), task('b')]);
    await opened(app, built.host, 'a', { demo: 1 });
    await opened(app, built.host, 'b', { demo: 2 });
    await finish(app, 'a');
    const second = await child(app, 'b');
    writeRunState(second, { status: 'waiting', currentStep: 'code-review' });
    await app.app.get(RunRepository).saveRun(second);
    built.host.conflicts.add(2);

    await pass(app);

    expect(built.host.merges).toEqual([1]);
    expect(built.rebased).toEqual([`${KEY}-b`]);
  });

  it('merges a task over two repositories one after the other, and only the one left after a crash between them', async () => {
    const built = await mergeWorld();
    app = built.app;
    await seedMergeParent(app, [task('a')]);
    await opened(app, built.host, 'a', { demo: 1, lib: 2 });
    await finish(app, 'a');
    built.host.crashOn = 2;

    await pass(app);

    expect(built.host.merges).toEqual([1]);

    built.host.crashOn = null;
    await pass(app);

    expect(built.host.merges).toEqual([1, 2]);
    expect(await statuses(app)).toEqual({ a: 'merged' });
    expect((await tasksOf(app))[0]?.merged).toEqual({
      demo: built.host.merged.get(1),
      lib: built.host.merged.get(2),
    });
  });

  it('does not merge twice when the host reports the request merged before it was recorded', async () => {
    const built = await mergeWorld();
    app = built.app;
    await seedMergeParent(app, [task('a')]);
    await opened(app, built.host, 'a', { demo: 1 });
    await finish(app, 'a');
    built.host.merged.set(1, 'abc123');

    await pass(app);

    expect(built.host.merges).toEqual([]);
    expect(await statuses(app)).toEqual({ a: 'merged' });
    expect((await tasksOf(app))[0]?.merged).toEqual({ demo: 'abc123' });
  });

  it('blocks the parent with the message of a host that refuses a merge for another reason than a conflict', async () => {
    const built = await mergeWorld();
    app = built.app;
    await seedMergeParent(app, [task('a')]);
    await opened(app, built.host, 'a', { demo: 1 });
    await finish(app, 'a');
    built.host.refusal = 'At least 1 approving review is required';

    await pass(app);

    const state = await parentState(app);
    expect(state.state).toBe('blocked');
    expect(state.reason).toMatchObject({ code: ERROR_CODES.SUBTASK_BLOCKED });
    expect(state.reason?.message).toContain('At least 1 approving review is required');
    expect(built.rebased).toEqual([]);
    expect(await statuses(app)).toEqual({ a: 'green' });
  });

  it('closes the merge requests of the subtasks on a Replay at plan', async () => {
    const built = await mergeWorld();
    app = built.app;
    await seedMergeParent(app, [task('a'), task('b')]);
    await opened(app, built.host, 'a', { demo: 1 });
    await opened(app, built.host, 'b', { demo: 2 });
    jest.spyOn(app.pipeline, 'replay').mockResolvedValue({ exitCode: 0, message: 'started' });

    await app.app.get(CommandService).submit('replay', KEY, { step: 'plan', prompt: 'again' });

    expect(built.host.closed).toEqual([1, 2]);
  });
});

describe('subtask questions', () => {
  let app: TestApp;

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  /** A parent with a plan chat and subtasks that have run once; the planner's replies are scripted. */
  async function questionWorld(replies: (prompt: string) => { text: string; exitCode?: number }) {
    const built = await world();
    app = built.app;
    const documents = app.app.get(DocumentRepository);
    const parent = await seedParent(app, [task('a'), task('b')]);
    await documents.putDocument(parent, 'contract', '- names are camelCase\n');
    await documents.putDocument(parent, 'repos', 'demo\n');
    const runtime = agentFor(app.app.get(AppConfig).env, parent, 'plan').runtime;
    mkdirSync(join(app.root, 'data'), { recursive: true });
    mkdirSync(agentStateDir(app.root, KEY, 'plan'), { recursive: true });
    writeFileSync(join(app.root, 'data', `${KEY}-plan-session.json`), JSON.stringify({ chatId: 'chat-1', runtime }));
    mkdirSync(join(app.root, 'worktrees', KEY, 'demo'), { recursive: true });
    const prompts: string[] = [];
    jest
      .spyOn(app.app.get<{ run: (input: AgentRunInput) => Promise<AgentRunResult> }>(AGENT_RUNNER), 'run')
      .mockImplementation((input) => {
        prompts.push(input.prompt);
        const { text, exitCode = 0 } = replies(input.prompt);
        return Promise.resolve({
          responseText: text ? resultAnswer('Done.', { answer: text }) : text,
          chatId: 'chat-1',
          tokensIn: 10,
          tokensOut: 5,
          usd: 0.5,
          killReason: null,
          exitCode,
          resumed: true,
          calls: 1,
          samples: [],
          durationMs: 1,
          startedAt: new Date(0).toISOString(),
          finishedAt: new Date(1).toISOString(),
        });
      });
    await pass(app);
    return { parent, prompts, documents };
  }

  /** The subtask run waits in research for its questions. */
  async function ask(id: string, questions: string, step = 'research'): Promise<void> {
    const run = await child(app, id);
    writeRunState(run, { status: 'waiting', currentStep: step });
    await app.app.get(RunRepository).saveRun(run);
    await app.app.get(DocumentRepository).putDocument(run, 'questions', questions);
  }

  it('answers a question from the plan chat of the parent, as a plan visit, and records it under decisions', async () => {
    const { prompts, documents, parent } = await questionWorld(() => ({ text: 'Use a column.' }));
    await ask('a', '- which field?\n');
    const before = await tasksOf(app);

    await pass(app);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('Subtask a asks:\n- which field?');
    expect(prompts[0]).toContain('names are camelCase');
    expect(await documents.latestBody(`${KEY}-a`, 'answers')).toBe('question: which field?\nanswer: Use a column.\n');
    expect(await documents.latestBody(KEY, 'contract')).toBe(
      '- names are camelCase\n\ndecisions:\n- subtask a: Use a column.\n',
    );
    expect(await tasksOf(app)).toEqual(before);
    const visits = await app.app.get(VisitRepository).listStats(parent.id);
    expect(visits.filter((visit) => visit.step === 'plan').map((visit) => visit.status)).toEqual(['done']);
    expect((await app.app.get(RunRepository).findRun(KEY))?.spentUsd).toBe(0.5);
  });

  it('tells the subtask to decide itself, and leaves the contract alone, when the planner fails', async () => {
    const { documents, parent } = await questionWorld(() => ({ text: '', exitCode: 1 }));
    await ask('a', '- which field?\n');

    await pass(app);

    expect(await documents.latestBody(`${KEY}-a`, 'answers')).toContain('Decide each one yourself');
    expect(await documents.latestBody(KEY, 'contract')).toBe('- names are camelCase\n');
    const visits = await app.app.get(VisitRepository).listStats(parent.id);
    expect(visits.filter((visit) => visit.step === 'plan').map((visit) => visit.status)).toEqual(['failed']);
  });

  it('asks two questions that wait at once one after the other, in task order', async () => {
    const { prompts, documents } = await questionWorld((prompt) => ({
      text: prompt.includes('Subtask a') ? 'A.' : 'B.',
    }));
    await ask('b', '- second?\n');
    await ask('a', '- first?\n');

    await pass(app);
    expect(prompts).toHaveLength(1);
    expect(await documents.latestBody(`${KEY}-b`, 'answers')).toBeNull();

    await pass(app);
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('Subtask b asks:');
    expect(await documents.latestBody(KEY, 'contract')).toContain('- subtask a: A.\n- subtask b: B.');
  });

  it('sends the planner reply again, and does not ask the planner again, when the delivery was refused', async () => {
    const { prompts, documents, parent } = await questionWorld(() => ({ text: 'Use a column.' }));
    await ask('a', '- which field?\n');
    const commands = app.app.get(CommandService);
    const submit = commands.submit.bind(commands);
    jest.spyOn(commands, 'submit').mockRejectedValueOnce(new Error('refused')).mockImplementation(submit);

    await pass(app);
    expect(await documents.latestBody(`${KEY}-a`, 'answers')).toBeNull();
    expect(await documents.latestBody(KEY, 'contract')).toBe('- names are camelCase\n');

    await pass(app);
    expect(prompts).toHaveLength(1);
    expect(await documents.latestBody(`${KEY}-a`, 'answers')).toBe('question: which field?\nanswer: Use a column.\n');
    expect(await documents.latestBody(KEY, 'contract')).toContain('- subtask a: Use a column.');
    const visits = await app.app.get(VisitRepository).listStats(parent.id);
    expect(visits.filter((visit) => visit.step === 'plan')).toHaveLength(1);
  });

  it('does not touch a subtask that is already past plan', async () => {
    const { prompts, documents } = await questionWorld(() => ({ text: 'late' }));
    await ask('a', '- which field?\n', 'plan');

    await pass(app);

    expect(prompts).toHaveLength(0);
    expect(await documents.latestBody(`${KEY}-a`, 'answers')).toBeNull();
    expect(await documents.latestBody(KEY, 'contract')).toBe('- names are camelCase\n');
  });

  it('leaves the parent as it was for a pass that finds nothing new, and records the fingerprint', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a')]);
    await pass(app);
    await work(app, 'a');
    const runs = app.app.get(RunRepository);
    const before = (await runs.findRun(KEY))!;
    const visits = (await app.app.get(VisitRepository).listStats(before.id)).length;

    await pass(app);

    const after = (await runs.findRun(KEY))!;
    expect(after.revision).toBe(before.revision);
    expect(deriveState(after).reason).toEqual(deriveState(before).reason);
    expect(await app.app.get(VisitRepository).listStats(after.id)).toHaveLength(visits);
    expect(after.subtaskFingerprint).toBe(await runs.subtaskFingerprint(after));
  });

  it('records what a pass saw, so a pass that starts a subtask is followed by one that sees the start', async () => {
    const built = await world();
    app = built.app;
    await seedParent(app, [task('a'), task('b', ['a'])]);
    const runs = app.app.get(RunRepository);
    const subtasks = app.app.get(SubtaskPort);

    await pass(app);
    let parent = (await runs.findRun(KEY))!;
    expect(parent.subtaskFingerprint).not.toBeNull();
    expect(await subtasks.subtasksChanged(parent)).toBe(true);
    expect(deriveState(parent).reason?.message).not.toMatch(/\d{4}-\d{2}-\d{2}T/);

    await pass(app);
    parent = (await runs.findRun(KEY))!;
    expect(await subtasks.subtasksChanged(parent)).toBe(false);

    await finish(app, 'a');
    expect(await subtasks.subtasksChanged(parent)).toBe(true);
  });
});
