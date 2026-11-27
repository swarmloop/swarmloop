import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { FakeClock } from '../../core/fake-clock.spec-helpers';
import type { EventRepository } from '../../history/event.repository';
import type { RunRepository } from '../../history/run.repository';
import type { CodeHost, PipelineDiagnosis, PipelineRef } from '../../integrations/code-host/code-host';
import { git } from '../../testing/git-fixture';
import type { StepContext } from '../base-step';
import { ERROR_CODES } from '../../contract/error-codes';
import type { RunRebase } from '../run-rebase';
import type { StepResult } from '../contract/step-contract';
import { ciFileProjects, missingPipeline, missingRuns } from './missing-pipeline';
import type { Seen } from './pipeline-report';

const KEY = 'PROJ-500';
const HOST_TEXT = 'merge request has a conflict with its base';
const CONFLICT: PipelineDiagnosis = { reason: HOST_TEXT, code: 'merge-conflict', httpCalls: [] };

interface World {
  root: string;
  run: { key: string; attemptsPipeline: number; currentStep: string; status: string };
  ref: PipelineRef;
  conflicts: (string | null)[];
  stored: Record<string, unknown>;
}

/** A worktree whose published sha, branch and files are what the step expects, and a run that waits at pipeline. */
function world(attemptsPipeline = 0): World {
  const root = mkdtempSync(join(tmpdir(), 'swarmloop-missing-pipeline-'));
  const cwd = join(root, 'worktrees', KEY, 'demo');
  mkdirSync(cwd, { recursive: true });
  git(cwd, ['init', '-b', 'feature/task']);
  git(cwd, ['remote', 'add', 'origin', 'https://gitlab.example/group/demo.git']);
  writeFileSync(join(cwd, 'a.txt'), 'a\n');
  git(cwd, ['add', '.']);
  git(cwd, ['-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-m', 'first']);
  const sha = git(cwd, ['rev-parse', 'HEAD']);
  return {
    root,
    run: { key: KEY, attemptsPipeline, currentStep: 'pipeline', status: 'running' },
    ref: { project: 'group/demo', ref: 'feature/task', sha },
    conflicts: [],
    stored: { repos: ['demo'] },
  };
}

function look(w: World, diagnosis: PipelineDiagnosis, limit = 6): Promise<StepResult> {
  const ctx = {
    opened: { run: w.run, startedAt: '2026-01-01T00:00:00.000Z' },
    calls: [],
    clock: new FakeClock(),
    reread: (artifact: { kind: string }) => Promise.resolve(w.stored[artifact.kind] ?? null),
    write: () => Promise.resolve(),
  } as unknown as StepContext;
  // The Rebase answers as RunRebase does for a head it leaves in place: the run goes to implement.
  const rebase: Pick<RunRebase, 'rebase'> = {
    rebase: (_key, _resume, _byParent, _byMain, _keepsWait, hostConflict) => {
      w.conflicts.push(hostConflict ?? null);
      w.run.currentStep = 'implement';
      w.run.status = 'waiting';
      return Promise.resolve('resolve');
    },
  };
  return missingPipeline({
    ctx,
    runs: {} as RunRepository,
    events: { recordLoop: () => Promise.resolve() } as unknown as EventRepository,
    rebase,
    halted: () => false,
    root: w.root,
    limit,
    host: { diagnoseMissingPipeline: () => Promise.resolve(diagnosis) } as unknown as CodeHost,
    records: [w.ref],
    seen: [
      {
        project: 'group/demo',
        id: null,
        sha: w.ref.sha ?? '',
        url: '',
        status: '',
        jobs: [],
        runs: [],
        checks: [],
        awaiting: [],
      },
    ],
    missing: ['demo'],
  });
}

describe('missingPipeline', () => {
  it('rebases a conflict whose commit was tried before, and hands the host text to implement', async () => {
    const w = world();
    w.stored.pipeline_rebases = JSON.stringify([`group/demo@${w.ref.sha}`]);

    const result = await look(w, CONFLICT);

    expect(result.route).toMatchObject({ to: 'wait', reason: 'automatic rebase' });
    expect(w.run.attemptsPipeline).toBe(1);
    const ended = await result.afterClose?.({ exitCode: 0, message: '' });
    expect(w.conflicts).toEqual([HOST_TEXT]);
    expect(ended?.resume).toBe(false);
    expect(w.run.currentStep).toBe('implement');
    expect(w.run.status).not.toBe('blocked');
  });

  it('waits with the next look for a diagnosis with no code', async () => {
    const w = world();

    const result = await look(w, { reason: null, httpCalls: [] });

    expect(result.route).toMatchObject({ to: 'wait', code: ERROR_CODES.CI_NOT_STARTED });
    expect(result.route).toMatchObject({ reason: expect.stringContaining('next look at') });
    expect(w.run.attemptsPipeline).toBe(0);
  });

  it('stops at the limit and says how many automatic rebases were tried', async () => {
    const w = world(6);

    const result = await look(w, CONFLICT, 6);

    expect(result.route).toMatchObject({
      to: 'block',
      reason: expect.stringContaining('automatic rebase limit reached after 6 automatic rebases'),
    });
    expect(w.run.attemptsPipeline).toBe(6);
  });

  it('stops for a worktree whose files changed', async () => {
    const w = world();
    writeFileSync(join(w.root, 'worktrees', KEY, 'demo', 'manual.txt'), 'edit');

    const result = await look(w, CONFLICT);

    expect(result.route).toMatchObject({
      to: 'block',
      reason: expect.stringContaining('published SHA, local branch or working files changed'),
    });
    expect(w.run.attemptsPipeline).toBe(0);
  });
});

describe('missingRuns', () => {
  function withWorkflow(): World {
    const w = world();
    mkdirSync(join(w.root, 'worktrees', KEY, 'demo', '.github', 'workflows'), { recursive: true });
    writeFileSync(join(w.root, 'worktrees', KEY, 'demo', '.github', 'workflows', 'ci.yml'), 'name: ci\n');
    return w;
  }

  function lookAt(w: World, seen: Seen[]): Promise<string[] | null> {
    const ctx = {
      opened: { run: w.run },
      reread: (artifact: { kind: string }) => Promise.resolve(w.stored[artifact.kind] ?? null),
    } as unknown as StepContext;
    return missingRuns(ctx, w.root, seen);
  }

  const noRun = (project: string): Seen => ({
    project,
    id: null,
    sha: '',
    url: '',
    status: 'none',
    jobs: [],
    runs: [],
    checks: [],
    awaiting: [],
  });

  it('does not list a repository whose project is not watched', async () => {
    await expect(lookAt(withWorkflow(), [noRun('group/other')])).resolves.toEqual([]);
  });

  it('lists a watched repository with a workflow file and no run', async () => {
    await expect(lookAt(withWorkflow(), [noRun('group/demo')])).resolves.toEqual(['demo']);
  });
});

describe('ciFileProjects', () => {
  function read(w: World): Promise<Set<string>> {
    const ctx = {
      opened: { run: w.run },
      reread: (artifact: { kind: string }) => Promise.resolve(w.stored[artifact.kind] ?? null),
    } as unknown as StepContext;
    return ciFileProjects(ctx, w.root);
  }

  it('names the origin project of a repository whose tree has a workflow file', async () => {
    const w = world();
    const workflows = join(w.root, 'worktrees', KEY, 'demo', '.github', 'workflows');
    mkdirSync(workflows, { recursive: true });
    writeFileSync(join(workflows, 'ci.yml'), 'name: ci\n');
    await expect(read(w)).resolves.toEqual(new Set(['group/demo']));
  });

  it('leaves out a repository whose tree has no CI file', async () => {
    await expect(read(world())).resolves.toEqual(new Set());
  });

  it('is empty when the repo list is missing', async () => {
    const w = world();
    delete w.stored.repos;
    await expect(read(w)).resolves.toEqual(new Set());
  });
});
