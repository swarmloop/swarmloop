import 'reflect-metadata';

import { getRepositoryToken } from '@nestjs/typeorm';

import { existsSync, mkdirSync, readFileSync, rmSync } from 'fs';

import { mkdtemp, writeFile } from 'fs/promises';

import { tmpdir } from 'os';

import { join } from 'path';

import type { Repository } from 'typeorm';

import { CheckoutEntity, DocumentEntity, StepStatEntity } from '../../history/entities';

import { RunRepository } from '../../history/run.repository';

import { DocumentRepository } from '../../history/document.repository';

import { PipelineService } from '../../pipeline/pipeline.service';

import { PrepareStep } from './prepare.step';

import { boot, seedRequirements, repoWithMain, git, hostFetch, commitFile } from './prepare.step.spec-helpers';

describe('prepare step', () => {
  it('fails when no project was stored and does not scan other repositories', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-empty-'));
    const swarm = join(parent, 'swarm');
    const workspace = join(parent, 'workspace');
    mkdirSync(swarm);
    mkdirSync(workspace);
    const decoy = join(parent, 'decoy');
    git(parent, ['init', '-b', 'main', decoy]);
    commitFile(decoy, 'README', 'decoy\n', 'decoy');
    const app = await boot(swarm, '../workspace');
    try {
      await seedRequirements(app, 'PROJ-8');
      const result = await app.get(PipelineService).step('prepare', 'PROJ-8');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('projects is missing');
      expect(existsSync(join(workspace, 'PROJ-8'))).toBe(false);
      expect(existsSync(join(swarm, 'worktrees', 'decoy'))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('stores the selected projects on the run before the first step', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-pin-'));
    const swarm = join(parent, 'swarm');
    mkdirSync(swarm);
    const app = await boot(swarm, '..');
    try {
      const runs = app.get(RunRepository);
      const pipeline = app.get(PipelineService);
      const started = await pipeline.startDetached('PROJ-3', { prompt: 'ship the field', projects: ['app'] });
      expect(started.exitCode).toBe(0);
      const pinned = await runs.findRun('PROJ-3');
      expect(pinned?.projects).toBe('app\n');
      await pipeline.whenIdle('PROJ-3');
    } finally {
      await app.close();
    }
  });

  it('prepares only the stored project', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-project-'));
    const swarm = join(parent, 'swarm');
    mkdirSync(swarm);
    repoWithMain(parent, 'app');
    repoWithMain(parent, 'other');
    const app = await boot(swarm, '..');
    try {
      await seedRequirements(app, 'PROJ-9');
      const runs = app.get(RunRepository);
      const run = await runs.findRun('PROJ-9');
      if (!run) {
        throw new Error('run is missing');
      }
      run.projects = 'app\n';
      await runs.saveRun(run);
      const result = await app.get(PipelineService).step('prepare', 'PROJ-9');
      expect(result.exitCode).toBe(0);
      expect((await runs.findRun('PROJ-9'))?.codeHost).toBe('');
      expect(existsSync(join(swarm, 'worktrees', 'PROJ-9', 'app'))).toBe(true);
      expect(existsSync(join(swarm, 'worktrees', 'PROJ-9', 'other'))).toBe(false);
      expect(existsSync(join(parent, 'PROJ-9'))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('registers a clone by folder name and refuses a missing one', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-add-'));
    const swarm = join(parent, 'swarm');
    mkdirSync(swarm);
    repoWithMain(parent, 'demo');
    const app = await boot(swarm, '..');
    try {
      const prepare = app.get(PrepareStep);
      await expect(prepare.addClone('missing')).rejects.toThrow('missing is not a git checkout');
      expect(await prepare.addClone('demo')).toEqual({ name: 'demo' });
      expect(await prepare.listClones()).toEqual([{ name: 'demo' }]);
    } finally {
      await app.close();
    }
  });

  it('resolves an empty checkout path from CHECKOUTS_ROOT and ignores other directories', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-root-'));
    const swarm = join(parent, 'swarm');
    mkdirSync(swarm);
    const clone = repoWithMain(parent, 'demo');
    repoWithMain(parent, 'other');
    const app = await boot(swarm, '..');
    try {
      await seedRequirements(app, 'PROJ-15');
      const checkouts = app.get<Repository<CheckoutEntity>>(getRepositoryToken(CheckoutEntity));
      await checkouts.save(checkouts.create({ name: 'demo', path: '' }));
      const result = await app.get(PipelineService).step('prepare', 'PROJ-15');
      expect(result.exitCode).toBe(0);
      const worktree = join(swarm, 'worktrees', 'PROJ-15', 'demo');
      expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(git(clone, ['rev-parse', 'origin/main']));
      expect(existsSync(join(swarm, 'worktrees', 'PROJ-15', 'other'))).toBe(false);
      expect((await checkouts.findOneBy({ name: 'demo' }))?.path).toBe('');
    } finally {
      await app.close();
    }
  });

  it('keeps an absolute checkout path when CHECKOUTS_ROOT is set', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-abs-'));
    const swarm = join(parent, 'swarm');
    mkdirSync(swarm);
    repoWithMain(parent, 'demo');
    const clone = repoWithMain(parent, 'real');
    const app = await boot(swarm, '..');
    try {
      await seedRequirements(app, 'PROJ-16');
      const checkouts = app.get<Repository<CheckoutEntity>>(getRepositoryToken(CheckoutEntity));
      await checkouts.save(checkouts.create({ name: 'demo', path: clone }));
      const result = await app.get(PipelineService).step('prepare', 'PROJ-16');
      expect(result.exitCode).toBe(0);
      const worktree = join(swarm, 'worktrees', 'PROJ-16', 'demo');
      expect(existsSync(join(worktree, 'README'))).toBe(true);
      expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(git(clone, ['rev-parse', 'origin/main']));
    } finally {
      await app.close();
    }
  });

  it('fetches origin and adds a detached worktree without touching the dirty checkout', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-git-'));
    const clone = join(root, 'clone');
    const remote = join(root, 'remote.git');
    const publisher = join(root, 'publisher');
    const decoy = join(root, 'decoy');
    git(root, ['init', '-b', 'main', clone]);
    commitFile(clone, 'README', 'base\n', 'base');
    git(root, ['init', '--bare', remote]);
    git(remote, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    git(clone, ['remote', 'add', 'origin', remote]);
    git(clone, ['push', '-u', 'origin', 'main']);
    git(clone, ['checkout', '-b', 'dirty']);
    await writeFile(join(clone, 'local.txt'), 'noise\n');
    git(root, ['clone', remote, publisher]);
    commitFile(publisher, 'NEXT', 'next\n', 'next');
    git(publisher, ['push', 'origin', 'main']);
    git(root, ['init', '-b', 'main', decoy]);
    commitFile(decoy, 'README', 'decoy\n', 'decoy');

    const app = await boot(root);
    try {
      await seedRequirements(app, 'PROJ-9');
      const checkouts = app.get<Repository<CheckoutEntity>>(getRepositoryToken(CheckoutEntity));
      await checkouts.save(checkouts.create({ name: 'demo', path: clone }));
      const pipeline = app.get(PipelineService);
      const result = await pipeline.step('prepare', 'PROJ-9');
      expect(result.exitCode).toBe(0);
      expect(result.message).toContain('prepare done');
      expect(result.message).toContain('shared Docker stack');

      const worktree = join(root, 'worktrees', 'PROJ-9', 'demo');
      expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(git(clone, ['rev-parse', 'origin/main']));
      expect(git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
      expect(existsSync(join(worktree, 'NEXT'))).toBe(true);
      expect(existsSync(join(clone, 'NEXT'))).toBe(false);
      expect(existsSync(join(clone, 'local.txt'))).toBe(true);
      expect(git(clone, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('dirty');
      expect(existsSync(join(root, 'worktrees', 'PROJ-9', 'decoy'))).toBe(false);
      expect(await app.get(DocumentRepository).hasDocument('PROJ-9', 'repos')).toBe(false);

      const run = await app.get(RunRepository).findRun('PROJ-9');
      expect(run?.status).toBe('waiting');
      expect(run?.currentStep).toBe('research');
      const stats = await app.get<Repository<StepStatEntity>>(getRepositoryToken(StepStatEntity)).find();
      expect(stats.some((stat) => stat.step === 'prepare' && stat.status === 'done')).toBe(true);

      await writeFile(join(worktree, 'note.txt'), 'keep\n');
      const again = await pipeline.step('prepare', 'PROJ-9');
      expect(again.exitCode).toBe(0);
      expect(existsSync(join(worktree, 'note.txt'))).toBe(true);
      expect(git(clone, ['worktree', 'list'])).toContain(worktree);
      expect(
        git(clone, ['worktree', 'list'])
          .split('\n')
          .filter((line) => line.includes('worktrees')),
      ).toHaveLength(1);
    } finally {
      await app.close();
    }
  });

  it('fetches the remote tip through the token url when origin is ssh', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-ssh-'));
    const clone = repoWithMain(root, 'clone');
    const bare = join(root, 'clone.git');
    const stale = git(clone, ['rev-parse', 'origin/main']);
    const publisher = join(root, 'publisher');
    git(root, ['clone', bare, publisher]);
    commitFile(publisher, 'NEXT', 'next\n', 'next');
    git(publisher, ['push', 'origin', 'main']);
    const tip = git(bare, ['rev-parse', 'refs/heads/main']);
    expect(tip).not.toBe(stale);
    git(clone, ['remote', 'set-url', 'origin', 'git@gitlab.example:group/demo.git']);
    const token = 's3cret-token';
    const restore = hostFetch([[`url.${bare}.insteadOf`, `https://oauth2:${token}@gitlab.example/group/demo.git`]]);
    try {
      const app = await boot(root, undefined, { gitlab: 'https://gitlab.example', gitlabToken: token });
      try {
        await seedRequirements(app, 'PROJ-17');
        const checkouts = app.get<Repository<CheckoutEntity>>(getRepositoryToken(CheckoutEntity));
        await checkouts.save(checkouts.create({ name: 'demo', path: clone }));
        const result = await app.get(PipelineService).step('prepare', 'PROJ-17');
        expect(result.exitCode).toBe(0);
        expect(result.message).not.toContain(token);
        const worktree = join(root, 'worktrees', 'PROJ-17', 'demo');
        expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(tip);
        expect(git(worktree, ['rev-parse', 'HEAD'])).not.toBe(stale);
        expect(git(clone, ['rev-parse', 'origin/main'])).toBe(tip);
        expect(git(clone, ['config', '--local', '--list'])).not.toContain(token);
        expect(readFileSync(join(clone, '.git', 'FETCH_HEAD'), 'utf8')).not.toContain(token);
        expect(readFileSync(join(clone, '.git', 'logs', 'refs', 'remotes', 'origin', 'main'), 'utf8')).not.toContain(
          token,
        );
        expect(existsSync(join(worktree, 'NEXT'))).toBe(true);
      } finally {
        await app.close();
      }
    } finally {
      restore();
    }
  });

  it('fails an ssh origin when the token is missing and creates no worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-ssh-token-'));
    const clone = repoWithMain(root, 'clone');
    git(clone, ['remote', 'set-url', 'origin', 'git@gitlab.example:group/demo.git']);
    const app = await boot(root, undefined, { gitlab: 'https://gitlab.example' });
    try {
      await seedRequirements(app, 'PROJ-17');
      const checkouts = app.get<Repository<CheckoutEntity>>(getRepositoryToken(CheckoutEntity));
      await checkouts.save(checkouts.create({ name: 'demo', path: clone }));
      const result = await app.get(PipelineService).step('prepare', 'PROJ-17');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('demo prepare failed: GITLAB_TOKEN is missing');
      expect(result.message).not.toContain('rebase failed');
      expect(existsSync(join(root, 'worktrees', 'PROJ-17', 'demo'))).toBe(false);
    } finally {
      await app.close();
    }
  });

  it('fails prepare when the fetch fails and redacts the token', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-redact-'));
    const clone = repoWithMain(root, 'clone');
    const stale = git(clone, ['rev-parse', 'origin/main']);
    git(clone, ['remote', 'set-url', 'origin', 'git@gitlab.example:group/demo.git']);
    const token = 's3cret-token';
    const restore = hostFetch([
      [`url.https://127.0.0.1:1/${token}/demo.git.insteadOf`, `https://oauth2:${token}@gitlab.example/group/demo.git`],
    ]);
    try {
      const app = await boot(root, undefined, { gitlab: 'https://gitlab.example', gitlabToken: token });
      try {
        await seedRequirements(app, 'PROJ-21');
        const checkouts = app.get<Repository<CheckoutEntity>>(getRepositoryToken(CheckoutEntity));
        await checkouts.save(checkouts.create({ name: 'demo', path: clone }));
        const result = await app.get(PipelineService).step('prepare', 'PROJ-21');
        expect(result.exitCode).toBe(1);
        expect(result.message).toContain('demo prepare failed');
        expect(result.message).toContain('unable to access');
        expect(result.message).toContain('***');
        expect(result.message).not.toContain(token);
        expect(result.message).not.toContain('rebase failed');
        expect(existsSync(join(root, 'worktrees', 'PROJ-21', 'demo'))).toBe(false);
        expect(git(clone, ['rev-parse', 'origin/main'])).toBe(stale);
        expect(git(clone, ['config', '--local', '--list'])).not.toContain(token);
      } finally {
        await app.close();
      }
    } finally {
      restore();
    }
  });

  it('detaches at HEAD when the checkout has no origin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-head-'));
    const clone = join(root, 'clone');
    git(root, ['init', '-b', 'main', clone]);
    commitFile(clone, 'README', 'base\n', 'base');
    const head = git(clone, ['rev-parse', 'HEAD']);
    const app = await boot(root);
    try {
      await seedRequirements(app, 'PROJ-22');
      const checkouts = app.get<Repository<CheckoutEntity>>(getRepositoryToken(CheckoutEntity));
      await checkouts.save(checkouts.create({ name: 'demo', path: clone }));
      const result = await app.get(PipelineService).step('prepare', 'PROJ-22');
      expect(result.exitCode).toBe(0);
      const worktree = join(root, 'worktrees', 'PROJ-22', 'demo');
      expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(head);
      expect(git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
    } finally {
      await app.close();
    }
  });

  it('fails a checkout that is not a git repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-bad-'));
    const app = await boot(root);
    try {
      await seedRequirements(app, 'PROJ-10');
      const checkouts = app.get<Repository<CheckoutEntity>>(getRepositoryToken(CheckoutEntity));
      await checkouts.save(checkouts.create({ name: '../nope', path: join(root, 'missing') }));
      const result = await app.get(PipelineService).step('prepare', 'PROJ-10');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('checkout name is invalid');
      expect(existsSync(join(root, 'nope'))).toBe(false);
      const run = await app.get(RunRepository).findRun('PROJ-10');
      expect(run?.status).toBe('failed');
      expect(run?.ownerPid).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('retries the checkout that failed and leaves the one that succeeded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-partial-'));
    const alpha = repoWithMain(root, 'alpha');
    const beta = join(root, 'beta');
    mkdirSync(beta);
    const app = await boot(root);
    try {
      await seedRequirements(app, 'PROJ-11');
      const checkouts = app.get<Repository<CheckoutEntity>>(getRepositoryToken(CheckoutEntity));
      await checkouts.save(checkouts.create({ name: 'alpha', path: alpha }));
      await checkouts.save(checkouts.create({ name: 'beta', path: beta }));
      const pipeline = app.get(PipelineService);
      const first = await pipeline.step('prepare', 'PROJ-11');
      expect(first.exitCode).toBe(1);
      expect(first.message).toContain('beta is not a git checkout');
      expect(existsSync(join(root, 'worktrees', 'PROJ-11', 'alpha'))).toBe(true);
      const failed = await app.get(RunRepository).findRun('PROJ-11');
      expect(failed?.status).toBe('failed');
      expect(failed?.currentStep).toBe('prepare');

      repoWithMain(root, 'beta');
      const second = await pipeline.step('prepare', 'PROJ-11');
      expect(second.exitCode).toBe(0);
      expect(existsSync(join(root, 'worktrees', 'PROJ-11', 'beta'))).toBe(true);
      expect(
        git(alpha, ['worktree', 'list'])
          .split('\n')
          .filter((line) => line.includes('worktrees')),
      ).toHaveLength(1);
      const run = await app.get(RunRepository).findRun('PROJ-11');
      expect(run?.currentStep).toBe('research');
      expect(run?.ownerPid).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('moves a clean worktree to the new origin/main and refuses a dirty one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-align-'));
    const clone = repoWithMain(root, 'clone');
    git(clone, ['checkout', '-b', 'dirty']);
    await writeFile(join(clone, 'local.txt'), 'noise\n');
    const publisher = join(root, 'publisher');
    git(root, ['clone', join(root, 'clone.git'), publisher]);
    const app = await boot(root);
    try {
      await seedRequirements(app, 'PROJ-12');
      const checkouts = app.get<Repository<CheckoutEntity>>(getRepositoryToken(CheckoutEntity));
      await checkouts.save(checkouts.create({ name: 'demo', path: clone }));
      const pipeline = app.get(PipelineService);
      expect((await pipeline.step('prepare', 'PROJ-12')).exitCode).toBe(0);
      const worktree = join(root, 'worktrees', 'PROJ-12', 'demo');
      await writeFile(join(worktree, 'note.txt'), 'keep\n');
      commitFile(publisher, 'NEXT', 'next\n', 'next');
      git(publisher, ['push', 'origin', 'main']);
      const blocked = await pipeline.step('prepare', 'PROJ-12');
      expect(blocked.exitCode).toBe(1);
      expect(blocked.message).toContain('demo worktree is dirty');
      expect(existsSync(join(worktree, 'note.txt'))).toBe(true);
      expect(git(clone, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('dirty');
      const paused = await app.get(RunRepository).findRun('PROJ-12');
      expect(paused?.currentStep).toBe('research');
      expect(paused?.status).toBe('waiting');

      rmSync(join(worktree, 'note.txt'));
      const moved = await pipeline.step('prepare', 'PROJ-12');
      expect(moved.exitCode).toBe(0);
      expect((await app.get(RunRepository).findRun('PROJ-12'))?.currentStep).toBe('research');
      expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(git(clone, ['rev-parse', 'origin/main']));
      expect(existsSync(join(worktree, 'NEXT'))).toBe(true);
      expect(existsSync(join(clone, 'NEXT'))).toBe(false);
      expect(git(clone, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('dirty');
    } finally {
      await app.close();
    }
  });

  it('replaces an empty leftover directory and does not rewind a later step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-later-'));
    const clone = repoWithMain(root, 'clone');
    mkdirSync(join(root, 'worktrees', 'PROJ-13', 'demo'), { recursive: true });
    const app = await boot(root);
    try {
      await seedRequirements(app, 'PROJ-13');
      const runs = app.get(RunRepository);
      const run = await runs.findRun('PROJ-13');
      if (!run) {
        throw new Error('run is missing');
      }
      run.currentStep = 'branch';
      run.status = 'waiting';
      await runs.saveRun(run);
      const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
      await documents.save(
        documents.create({
          runId: run.id,
          stepStatId: 0,
          kind: 'repos',
          attempt: 1,
          body: '{}\n',
          path: '',
          createdAt: new Date().toISOString(),
        }),
      );
      const checkouts = app.get<Repository<CheckoutEntity>>(getRepositoryToken(CheckoutEntity));
      await checkouts.save(checkouts.create({ name: 'demo', path: clone }));
      const result = await app.get(PipelineService).step('prepare', 'PROJ-13');
      expect(result.exitCode).toBe(0);
      expect(git(join(root, 'worktrees', 'PROJ-13', 'demo'), ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
      const kept = await runs.findRun('PROJ-13');
      expect(kept?.currentStep).toBe('branch');
      expect(kept?.status).toBe('waiting');
    } finally {
      await app.close();
    }
  });
});
