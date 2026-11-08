import 'reflect-metadata';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { join } from 'path';
import { ERROR_CODES } from '../contract/error-codes';
import type { SwarmloopError } from '../core/swarmloop-error';
import { REBASE_JOURNAL } from '../git/rebase';
import { DocumentRepository } from '../history/document.repository';
import { EventRepository } from '../history/event.repository';
import { RunRepository } from '../history/run.repository';
import { commitFile, git } from '../steps/prepare/prepare.step.spec-helpers';
import { WorkspaceGuard } from './workspace-guard';
import { clean, freshRun, makeWorld, type World } from './workspace.spec-helpers';

const SETUP = JSON.stringify({ repo: 'demo', ref: 'abc', config: {}, setup: { command: 'npm ci', exitCode: 0 } });

async function ensure(world: World): Promise<void> {
  await world.app.get(WorkspaceGuard).ensure(await freshRun(world));
}

async function failure(world: World): Promise<SwarmloopError> {
  try {
    await ensure(world);
  } catch (error) {
    return error as SwarmloopError;
  }
  throw new Error('ensure did not throw');
}

describe('WorkspaceGuard', () => {
  let world: World;

  afterEach(async () => {
    await world.app.close();
  });

  it('recreates a removed worktree on the local branch, locked, and marks the setup stale', async () => {
    world = await makeWorld('PROJ-1');
    const documents = world.app.get(DocumentRepository);
    await documents.putDocument(await freshRun(world), 'environment:demo', SETUP);
    await clean(world);
    expect(existsSync(world.worktree)).toBe(false);

    await ensure(world);

    expect(git(world.worktree, ['branch', '--show-current'])).toBe(world.branch);
    expect(existsSync(join(world.worktree, 'feature.txt'))).toBe(true);
    expect(git(world.clone, ['worktree', 'list', '--porcelain'])).toContain('locked swarmloop run PROJ-1');
    expect((await freshRun(world)).workspace).toBeNull();
    const record = JSON.parse((await documents.latestBody('PROJ-1', 'environment:demo')) ?? '{}');
    expect(record.setup).toBeUndefined();
  });

  it('does nothing for a run whose worktree is in place', async () => {
    world = await makeWorld('PROJ-2');
    const before = git(world.worktree, ['rev-parse', 'HEAD']);

    await ensure(world);

    expect(git(world.worktree, ['rev-parse', 'HEAD'])).toBe(before);
    expect(git(world.clone, ['worktree', 'list', '--porcelain'])).toContain('locked');
  });

  it('recreates from origin/<branch> when the local branch is gone', async () => {
    world = await makeWorld('PROJ-3');
    await clean(world);
    git(world.clone, ['branch', '-D', world.branch]);

    await ensure(world);

    expect(git(world.worktree, ['branch', '--show-current'])).toBe(world.branch);
    expect(git(world.worktree, ['rev-parse', 'HEAD'])).toBe(world.sha);
  });

  it('recreates from the published SHA when the local branch and origin are both gone', async () => {
    world = await makeWorld('PROJ-4', 'github');
    await clean(world);
    git(world.clone, ['branch', '-D', world.branch]);

    await ensure(world);

    expect(git(world.worktree, ['branch', '--show-current'])).toBe(world.branch);
    expect(git(world.worktree, ['rev-parse', 'HEAD'])).toBe(world.sha);
  });

  it('blocks with WORKSPACE_LOST, naming the repo, when nothing is left', async () => {
    world = await makeWorld('PROJ-5', 'github');
    await clean(world);
    git(world.clone, ['branch', '-D', world.branch]);
    await world.app
      .get(DocumentRepository)
      .putDocument(await freshRun(world), 'pipeline_ref', 'project: acme/demo\nref: x\nsha: deadbeef\n');

    const error = await failure(world);

    expect(error.code).toBe(ERROR_CODES.WORKSPACE_LOST);
    expect(error.message).toContain('demo');
    expect(existsSync(world.worktree)).toBe(false);
  });

  it('keeps an uncommitted change when the host pruned the registration', async () => {
    world = await makeWorld('PROJ-6');
    writeFileSync(join(world.worktree, 'feature.txt'), 'edited\n');
    writeFileSync(join(world.worktree, 'scratch.txt'), 'new\n');
    git(world.clone, ['worktree', 'unlock', world.worktree]);
    git(world.clone, ['worktree', 'prune', '--expire', 'now']);
    renameSync(world.worktree, `${world.worktree}-hold`);
    git(world.clone, ['worktree', 'prune', '--expire', 'now']);
    renameSync(`${world.worktree}-hold`, world.worktree);
    expect(git(world.clone, ['worktree', 'list', '--porcelain'])).not.toContain(world.worktree);

    await ensure(world);

    expect(readFileSync(join(world.worktree, 'feature.txt'), 'utf8')).toBe('edited\n');
    expect(readFileSync(join(world.worktree, 'scratch.txt'), 'utf8')).toBe('new\n');
    expect(git(world.worktree, ['status', '--porcelain'])).toContain('scratch.txt');
    expect(git(world.clone, ['worktree', 'list', '--porcelain'])).toContain(world.worktree);
    expect(existsSync(join(world.swarm, 'worktrees', 'PROJ-6', '.demo.moved'))).toBe(false);
  });

  it('keeps a locked registration through a host-style prune with the worktree path missing', async () => {
    world = await makeWorld('PROJ-7');
    renameSync(world.worktree, `${world.worktree}-away`);

    git(world.clone, ['worktree', 'prune', '--expire', 'now']);

    expect(git(world.clone, ['worktree', 'list', '--porcelain'])).toContain(world.worktree);
  });

  it('blocks with BRANCH_IN_USE, naming the path, when a person has the branch checked out', async () => {
    world = await makeWorld('PROJ-8');
    await clean(world);
    git(world.clone, ['checkout', world.branch]);

    const error = await failure(world);

    expect(error.code).toBe(ERROR_CODES.BRANCH_IN_USE);
    expect(error.message).toContain(world.clone);
    expect(error.message).toContain(`swarmloop/${world.branch}`);
    expect(existsSync(world.worktree)).toBe(false);
  });

  it('adopts local commits the published SHA lacks, once, and continues from that tip', async () => {
    world = await makeWorld('PROJ-9', 'github');
    await clean(world);
    git(world.clone, ['checkout', world.branch]);
    commitFile(world.clone, 'mine.txt', 'mine\n', 'mine');
    git(world.clone, ['checkout', 'main']);
    const tip = git(world.clone, ['rev-parse', world.branch]);

    await ensure(world);
    await ensure(world);

    expect(git(world.worktree, ['rev-parse', 'HEAD'])).toBe(tip);
    expect((await freshRun(world)).generation).toBe(1);
    const loops = await world.app.get(EventRepository).listLoops((await freshRun(world)).id);
    expect(loops.map((loop) => loop.reason)).toEqual(['adopted 1 commits']);
  });

  it('blocks with BRANCH_DIVERGED and pushes nothing when local and remote both moved', async () => {
    world = await makeWorld('PROJ-10');
    await clean(world);
    git(world.clone, ['checkout', world.branch]);
    commitFile(world.clone, 'local.txt', 'local\n', 'local');
    git(world.clone, ['checkout', 'main']);
    const other = join(world.parent, 'other');
    git(world.parent, ['clone', world.remote, other]);
    git(other, ['checkout', world.branch]);
    commitFile(other, 'remote.txt', 'remote\n', 'remote');
    git(other, ['push', 'origin', world.branch]);
    const remoteTip = git(other, ['rev-parse', 'HEAD']);

    const error = await failure(world);

    expect(error.code).toBe(ERROR_CODES.BRANCH_DIVERGED);
    expect(git(world.remote, ['rev-parse', world.branch])).toBe(remoteTip);
    expect(existsSync(world.worktree)).toBe(false);
  });

  it('blocks with REBASE_CONFLICT, naming the repo, instead of using a recreated worktree', async () => {
    world = await makeWorld('PROJ-11');
    const run = await freshRun(world);
    const entry = {
      path: world.worktree,
      branch: world.branch,
      oldHead: world.sha,
      fingerprint: 'f',
      protectRef: `refs/swarmloop/pre-rebase/${world.branch}`,
      expectedRemoteTip: null,
      baseSha: 'b',
      checkpoint: 'applying',
      generation: run.generation,
    };
    await world.app.get(DocumentRepository).putDocument(run, REBASE_JOURNAL, JSON.stringify({ demo: entry }));
    await clean(world);

    const error = await failure(world);

    expect(error.code).toBe(ERROR_CODES.REBASE_CONFLICT);
    expect(error.message).toContain('demo');
    expect(existsSync(world.worktree)).toBe(false);
  });

  it('leaves a run that never prepared alone', async () => {
    world = await makeWorld('PROJ-12');
    const runs = world.app.get(RunRepository);
    const fresh = await runs.begin('PROJ-13', 'requirements');

    await world.app.get(WorkspaceGuard).ensure(fresh);

    expect(existsSync(join(world.swarm, 'worktrees', 'PROJ-13'))).toBe(false);
  });
});
