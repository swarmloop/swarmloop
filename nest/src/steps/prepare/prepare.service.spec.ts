import 'reflect-metadata';
import { execFileSync } from 'child_process';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Repository } from 'typeorm';
import { SwarmloopConfigModule } from '../../config/config.module';
import { CheckoutEntity, DocumentEntity, StepStatEntity } from '../../history/entities';
import { HistoryService } from '../../history/history.service';
import { AGENT_RUNNER } from '../../limits/agent-runner';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { PipelineService } from '../../pipeline/pipeline.service';
import { PrepareService } from './prepare.service';
import { PASTE_READER } from '../../integrations/linked-pages/paste-page.reader';

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
      const history = app.get(HistoryService);
      const pipeline = app.get(PipelineService);
      const started = await pipeline.startDetached('PROJ-3', { prompt: 'ship the field', projects: ['app'] });
      expect(started.exitCode).toBe(0);
      const pinned = await history.findRun('PROJ-3');
      expect(pinned?.projects).toBe('app\n');
      for (let attempt = 0; attempt < 500 && pipeline.claimed('PROJ-3'); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
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
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-9');
      if (!run) {
        throw new Error('run is missing');
      }
      run.projects = 'app\n';
      await history.saveRun(run);
      const result = await app.get(PipelineService).step('prepare', 'PROJ-9');
      expect(result.exitCode).toBe(0);
      expect((await history.findRun('PROJ-9'))?.codeHost).toBe('');
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
      const prepare = app.get(PrepareService);
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
      expect(await app.get(HistoryService).hasDocument('PROJ-9', 'repos')).toBe(false);

      const run = await app.get(HistoryService).findRun('PROJ-9');
      expect(run?.status).toBe('waiting');
      expect(run?.currentStep).toBe('research');
      const stats = await app.get<Repository<StepStatEntity>>(getRepositoryToken(StepStatEntity)).find();
      expect(stats.some((stat) => stat.step === 'prepare' && stat.status === 'done')).toBe(true);

      await writeFile(join(worktree, 'note.txt'), 'keep\n');
      const again = await pipeline.step('prepare', 'PROJ-9');
      expect(again.exitCode).toBe(0);
      expect(existsSync(join(worktree, 'note.txt'))).toBe(true);
      expect(git(clone, ['worktree', 'list'])).toContain(worktree);
      expect(git(clone, ['worktree', 'list']).split('\n').filter((line) => line.includes('worktrees'))).toHaveLength(1);
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
        expect(readFileSync(join(clone, '.git', 'logs', 'refs', 'remotes', 'origin', 'main'), 'utf8')).not.toContain(token);
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
      const run = await app.get(HistoryService).findRun('PROJ-10');
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
      const failed = await app.get(HistoryService).findRun('PROJ-11');
      expect(failed?.status).toBe('failed');
      expect(failed?.currentStep).toBe('prepare');

      repoWithMain(root, 'beta');
      const second = await pipeline.step('prepare', 'PROJ-11');
      expect(second.exitCode).toBe(0);
      expect(existsSync(join(root, 'worktrees', 'PROJ-11', 'beta'))).toBe(true);
      expect(git(alpha, ['worktree', 'list']).split('\n').filter((line) => line.includes('worktrees'))).toHaveLength(1);
      const run = await app.get(HistoryService).findRun('PROJ-11');
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
      const paused = await app.get(HistoryService).findRun('PROJ-12');
      expect(paused?.currentStep).toBe('research');
      expect(paused?.status).toBe('waiting');

      rmSync(join(worktree, 'note.txt'));
      const moved = await pipeline.step('prepare', 'PROJ-12');
      expect(moved.exitCode).toBe(0);
      expect((await app.get(HistoryService).findRun('PROJ-12'))?.currentStep).toBe('research');
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
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-13');
      if (!run) {
        throw new Error('run is missing');
      }
      run.currentStep = 'branch';
      run.status = 'waiting';
      await history.saveRun(run);
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
      const kept = await history.findRun('PROJ-13');
      expect(kept?.currentStep).toBe('branch');
      expect(kept?.status).toBe('waiting');
    } finally {
      await app.close();
    }
  });

  it('continues prepare when the previous process is gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-dead-'));
    const clone = repoWithMain(root, 'clone');
    const app = await boot(root);
    try {
      await seedRequirements(app, 'PROJ-14');
      const history = app.get(HistoryService);
      const seeded = await history.findRun('PROJ-14');
      if (!seeded) {
        throw new Error('run is missing');
      }
      seeded.status = 'running';
      seeded.ownerPid = 2_147_483_646;
      seeded.currentStep = 'prepare';
      await history.saveRun(seeded);
      const checkouts = app.get<Repository<CheckoutEntity>>(getRepositoryToken(CheckoutEntity));
      await checkouts.save(checkouts.create({ name: 'demo', path: clone }));
      const result = await app.get(PipelineService).step('prepare', 'PROJ-14');
      expect(result.exitCode).toBe(0);
      expect(result.message).not.toContain('already running');
      expect(existsSync(join(root, 'worktrees', 'PROJ-14', 'demo'))).toBe(true);
      const run = await history.findRun('PROJ-14');
      expect(run?.currentStep).toBe('research');
      expect(run?.ownerPid).toBeNull();
    } finally {
      await app.close();
    }
  });

  it('detaches at origin/master when origin/main is absent', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-master-'));
    const clone = repoWithMaster(root, 'clone');
    const app = await boot(root);
    try {
      await seedRequirements(app, 'PROJ-18');
      const checkouts = app.get<Repository<CheckoutEntity>>(getRepositoryToken(CheckoutEntity));
      await checkouts.save(checkouts.create({ name: 'demo', path: clone }));
      const result = await app.get(PipelineService).step('prepare', 'PROJ-18');
      expect(result.exitCode).toBe(0);
      const worktree = join(root, 'worktrees', 'PROJ-18', 'demo');
      expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(git(clone, ['rev-parse', 'origin/master']));
      expect(git(clone, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('master');
    } finally {
      await app.close();
    }
  });

  it('stops when the named base is missing and detaches at that branch when it exists', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-branch-'));
    const swarm = join(parent, 'swarm');
    mkdirSync(swarm);
    const clone = repoWithBranch(parent, 'app');
    const base = git(clone, ['rev-parse', 'origin/feature/other']);
    const app = await boot(swarm, '..');
    try {
      await seedRequirements(app, 'PROJ-19');
      const history = app.get(HistoryService);
      const run = await history.findRun('PROJ-19');
      if (!run) {
        throw new Error('run is missing');
      }
      run.projects = 'app\n';
      run.prompt = 'branch: feature/missing\n';
      await history.saveRun(run);
      const missing = await app.get(PipelineService).step('prepare', 'PROJ-19');
      expect(missing.exitCode).toBe(1);
      expect(missing.message).toContain('app has no origin/feature/missing');
      expect(missing.message).not.toContain('origin/main');
      expect(existsSync(join(swarm, 'worktrees', 'PROJ-19', 'app'))).toBe(false);
      expect(git(clone, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('dirty');

      run.prompt = 'branch: feature/a\nbranch: feature/b\n';
      run.status = 'waiting';
      await history.saveRun(run);
      const ambiguous = await app.get(PipelineService).step('prepare', 'PROJ-19');
      expect(ambiguous.exitCode).toBe(1);
      expect(ambiguous.message).toContain('branch is ambiguous');

      run.prompt = 'Review the ticket\nbranch: feature/other\n';
      run.status = 'waiting';
      await history.saveRun(run);
      const result = await app.get(PipelineService).step('prepare', 'PROJ-19');
      expect(result.exitCode).toBe(0);
      const worktree = join(swarm, 'worktrees', 'PROJ-19', 'app');
      expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(base);
      expect(git(worktree, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
      expect(git(clone, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('dirty');
      expect(existsSync(join(clone, 'local.txt'))).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('moves a clean worktree onto the prompt branch and forks the feature branch from it', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-fork-'));
    const swarm = join(parent, 'swarm');
    mkdirSync(swarm);
    const clone = repoWithBranch(parent, 'app');
    const base = git(clone, ['rev-parse', 'origin/feature/other']);
    const app = await boot(swarm, '..');
    try {
      await seedRequirements(app, 'PROJ-40');
      const history = app.get(HistoryService);
      const seeded = await history.findRun('PROJ-40');
      if (!seeded) {
        throw new Error('run is missing');
      }
      seeded.projects = 'app\n';
      await history.saveRun(seeded);
      expect((await app.get(PipelineService).step('prepare', 'PROJ-40')).exitCode).toBe(0);
      const worktree = join(swarm, 'worktrees', 'PROJ-40', 'app');
      expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(git(clone, ['rev-parse', 'origin/main']));

      seeded.prompt = 'branch: origin/feature/other\n';
      seeded.status = 'waiting';
      await history.saveRun(seeded);
      expect((await app.get(PipelineService).step('prepare', 'PROJ-40')).exitCode).toBe(0);
      expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(base);
      expect(git(clone, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('dirty');

      await history.putDocument(
        seeded,
        'requirements',
        `${JSON.stringify({
          prompt: 'Ship the field\n',
          tickets: [{ key: 'PROJ-40', summary: 'Ship the field', description: '', acceptanceCriteria: '', comments: [] }],
          epic: null,
          epics: [],
          files: [],
          pages: [],
        })}\n`,
      );
      await history.putDocument(seeded, 'repos', 'app\n');
      const branched = await app.get(PipelineService).step('branch', 'PROJ-40');
      expect(branched.exitCode).toBe(0);
      expect(git(worktree, ['branch', '--show-current'])).toBe('feature/PROJ-40-ship-the-field');
      expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(base);
      expect(git(clone, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('dirty');
    } finally {
      await app.close();
    }
  });

  it('stores github when the origin matches GITHUB_BASE_URL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-github-'));
    const clone = repoWithMain(root, 'demo');
    const token = 's3cret-token';
    git(clone, ['remote', 'set-url', 'origin', 'git@github.com:acme/demo.git']);
    const restore = hostFetch([[`url.${join(root, 'demo.git')}.insteadOf`, `https://x-access-token:${token}@github.com/acme/demo.git`]]);
    try {
      const app = await boot(root, undefined, { github: 'https://github.com', githubToken: token });
      try {
        await seedRequirements(app, 'PROJ-30');
        const checkouts = app.get<Repository<CheckoutEntity>>(getRepositoryToken(CheckoutEntity));
        await checkouts.save(checkouts.create({ name: 'demo', path: clone }));
        const result = await app.get(PipelineService).step('prepare', 'PROJ-30');
        expect(result.exitCode).toBe(0);
        expect(result.message).not.toContain(token);
        expect((await app.get(HistoryService).findRun('PROJ-30'))?.codeHost).toBe('github');
      } finally {
        await app.close();
      }
    } finally {
      restore();
    }
  });

  it('stores gitlab when the origin matches GITLAB_BASE_URL', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-gitlab-'));
    const clone = repoWithMain(root, 'demo');
    const token = 's3cret-token';
    git(clone, ['remote', 'set-url', 'origin', 'git@gitlab.example:group/demo.git']);
    const restore = hostFetch([[`url.${join(root, 'demo.git')}.insteadOf`, `https://oauth2:${token}@gitlab.example/group/demo.git`]]);
    try {
      const app = await boot(root, undefined, { gitlab: 'https://gitlab.example', gitlabToken: token });
      try {
        await seedRequirements(app, 'PROJ-32');
        const checkouts = app.get<Repository<CheckoutEntity>>(getRepositoryToken(CheckoutEntity));
        await checkouts.save(checkouts.create({ name: 'demo', path: clone }));
        const result = await app.get(PipelineService).step('prepare', 'PROJ-32');
        expect(result.exitCode).toBe(0);
        expect(result.message).not.toContain(token);
        expect((await app.get(HistoryService).findRun('PROJ-32'))?.codeHost).toBe('gitlab');
      } finally {
        await app.close();
      }
    } finally {
      restore();
    }
  });

  it('fails when checkouts use different hosts and keeps the stored host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-mixed-'));
    const web = repoWithMain(root, 'web');
    const api = repoWithMain(root, 'api');
    const token = 's3cret-token';
    git(web, ['remote', 'set-url', 'origin', 'git@github.com:acme/web.git']);
    git(api, ['remote', 'set-url', 'origin', 'git@gitlab.example:group/api.git']);
    const restore = hostFetch([
      [`url.${join(root, 'web.git')}.insteadOf`, `https://x-access-token:${token}@github.com/acme/web.git`],
      [`url.${join(root, 'api.git')}.insteadOf`, `https://oauth2:${token}@gitlab.example/group/api.git`],
    ]);
    try {
      const app = await boot(root, undefined, {
        github: 'https://github.com',
        gitlab: 'https://gitlab.example',
        githubToken: token,
        gitlabToken: token,
      });
      try {
        await seedRequirements(app, 'PROJ-31');
        const history = app.get(HistoryService);
        const run = await history.findRun('PROJ-31');
        if (!run) {
          throw new Error('run is missing');
        }
        run.codeHost = 'github';
        await history.saveRun(run);
        const checkouts = app.get<Repository<CheckoutEntity>>(getRepositoryToken(CheckoutEntity));
        await checkouts.save(checkouts.create({ name: 'web', path: web }));
        await checkouts.save(checkouts.create({ name: 'api', path: api }));
        const result = await app.get(PipelineService).step('prepare', 'PROJ-31');
        expect(result.exitCode).toBe(1);
        expect(result.message).toContain('origins use github and gitlab');
        expect(result.message).not.toContain(token);
        expect((await history.findRun('PROJ-31'))?.codeHost).toBe('github');
      } finally {
        await app.close();
      }
    } finally {
      restore();
    }
  });

  it('replaces a stored host when every origin agrees', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-replace-'));
    const clone = repoWithMain(root, 'demo');
    const token = 's3cret-token';
    git(clone, ['remote', 'set-url', 'origin', 'git@github.com:acme/demo.git']);
    const restore = hostFetch([[`url.${join(root, 'demo.git')}.insteadOf`, `https://x-access-token:${token}@github.com/acme/demo.git`]]);
    try {
      const app = await boot(root, undefined, { github: 'https://github.com', githubToken: token });
      try {
        await seedRequirements(app, 'PROJ-33');
        const history = app.get(HistoryService);
        const run = await history.findRun('PROJ-33');
        if (!run) {
          throw new Error('run is missing');
        }
        run.codeHost = 'gitlab';
        await history.saveRun(run);
        const checkouts = app.get<Repository<CheckoutEntity>>(getRepositoryToken(CheckoutEntity));
        await checkouts.save(checkouts.create({ name: 'demo', path: clone }));
        const result = await app.get(PipelineService).step('prepare', 'PROJ-33');
        expect(result.exitCode).toBe(0);
        expect(result.message).not.toContain(token);
        expect((await history.findRun('PROJ-33'))?.codeHost).toBe('github');
      } finally {
        await app.close();
      }
    } finally {
      restore();
    }
  });

  it('refuses an appended checkout on the other host', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-append-'));
    const swarm = join(parent, 'swarm');
    mkdirSync(swarm);
    const clone = repoWithMain(parent, 'other');
    const token = 's3cret-token';
    git(clone, ['remote', 'set-url', 'origin', 'git@gitlab.example:group/other.git']);
    const restore = hostFetch([[`url.${join(parent, 'other.git')}.insteadOf`, `https://oauth2:${token}@gitlab.example/group/other.git`]]);
    try {
      const app = await boot(swarm, '..', {
        github: 'https://github.com',
        gitlab: 'https://gitlab.example',
        gitlabToken: token,
      });
      try {
        await seedRequirements(app, 'PROJ-34');
        const history = app.get(HistoryService);
        const run = await history.findRun('PROJ-34');
        if (!run) {
          throw new Error('run is missing');
        }
        run.codeHost = 'github';
        await history.saveRun(run);
        await expect(app.get(PrepareService).ensureDetached(run, ['other'], null, false)).rejects.toThrow(/origin is not github/);
        expect((await history.findRun('PROJ-34'))?.codeHost).toBe('github');
      } finally {
        await app.close();
      }
    } finally {
      restore();
    }
  });

  it('removes a dirty worktree and leaves the checkout branch', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-remove-'));
    const swarm = join(parent, 'swarm');
    mkdirSync(swarm);
    const clone = repoWithMain(parent, 'demo');
    const tree = join(swarm, 'worktrees', 'PROJ-70', 'demo');
    mkdirSync(join(tree, '..'), { recursive: true });
    git(clone, ['worktree', 'add', '-b', 'feature/PROJ-70-ship', tree, 'main']);
    writeFileSync(join(tree, 'dirty.txt'), 'dirty\n');
    const app = await boot(swarm, '..');
    try {
      await app.get(PrepareService).removeWorktrees('PROJ-70');
      expect(existsSync(tree)).toBe(false);
      expect(existsSync(join(swarm, 'worktrees', 'PROJ-70'))).toBe(false);
      expect(existsSync(join(clone, 'README'))).toBe(true);
      expect(git(clone, ['branch', '--list', 'feature/PROJ-70-ship'])).toBe('feature/PROJ-70-ship');
      expect(git(clone, ['worktree', 'list'])).not.toContain(tree);
    } finally {
      await app.close();
    }
  });

  it('deletes a worktree when the checkout is already gone', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-remove-missing-'));
    const swarm = join(parent, 'swarm');
    mkdirSync(swarm);
    const clone = repoWithMain(parent, 'demo');
    const tree = join(swarm, 'worktrees', 'PROJ-71', 'demo');
    mkdirSync(join(tree, '..'), { recursive: true });
    git(clone, ['worktree', 'add', '--detach', tree, 'main']);
    rmSync(clone, { recursive: true, force: true });
    const app = await boot(swarm, '..');
    try {
      await app.get(PrepareService).removeWorktrees('PROJ-71');
      expect(existsSync(join(swarm, 'worktrees', 'PROJ-71'))).toBe(false);
    } finally {
      await app.close();
    }
  });
});

async function boot(
  root: string,
  checkoutsRoot?: string,
  bases: { gitlab?: string; github?: string; gitlabToken?: string; githubToken?: string } = {},
): Promise<TestingModule> {
  await writeFile(
    join(root, '.env'),
    [
      'RUNTIME=cursor',
      'REQUIREMENTS_VIA=direct',
      'ISSUE_TRACKER=jira',
      'JIRA_BASE_URL=http://127.0.0.1:9',
      'JIRA_EMAIL=dev@example.com',
      'JIRA_API_TOKEN=token',
      `GITLAB_BASE_URL=${bases.gitlab ?? ''}`,
      `GITLAB_TOKEN=${bases.gitlabToken ?? ''}`,
      `GITHUB_BASE_URL=${bases.github ?? ''}`,
      `GITHUB_TOKEN=${bases.githubToken ?? ''}`,
      'CURSOR_API_KEY=',
      'ANTHROPIC_API_KEY=',
      'MAX_AGENT_CALLS=20',
      'MAX_RETURNS=3',
      'MAX_LAUNCHES=3',
      'MAX_RUN_USD=25',
      'IDLE_TIMEOUT_MS=900000',
      'TICK_MS=15000',
      'REQUIREMENTS_TIMEOUT_MS=600000',
      'RESEARCH_TIMEOUT_MS=900000',
      'PLAN_TIMEOUT_MS=1200000',
      'IMPLEMENT_TIMEOUT_MS=1800000',
      'CODE_REVIEW_TIMEOUT_MS=900000',
      'MERGE_REQUEST_TIMEOUT_MS=600000',
      'PIPELINE_TIMEOUT_MS=1800000',
      'PIPELINE_START_TIMEOUT_MS=180000',
      'MODEL_RESEARCH=grok-4.7',
      'MODEL_PLAN=opus-5.5-extra-high',
      'MODEL_IMPLEMENT=grok-4.7',
      'SWARMLOOP_API_PORT=3920',
      'SWARMLOOP_API_HOST=127.0.0.1',
      `SWARMLOOP_ROOT=${root}`,
      checkoutsRoot === undefined ? '' : `CHECKOUTS_ROOT=${checkoutsRoot}`,
      '',
    ].join('\n'),
  );
  return Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), PipelineModule],
  })
    .overrideProvider(PASTE_READER)
    .useValue({ read: jest.fn() })
    .overrideProvider(AGENT_RUNNER)
    .useValue({ run: jest.fn() })
    .compile();
}

async function seedRequirements(app: TestingModule, key: string): Promise<void> {
  const history = app.get(HistoryService);
  const seeded = await history.begin(key, 'requirements');
  seeded.status = 'waiting';
  await history.saveRun(seeded);
  const documents = app.get<Repository<DocumentEntity>>(getRepositoryToken(DocumentEntity));
  await documents.save(
    documents.create({
      runId: seeded.id,
      stepStatId: 0,
      kind: 'requirements',
      attempt: 1,
      body: '{}\n',
      path: '',
      createdAt: new Date().toISOString(),
    }),
  );
}

function repoWithMain(root: string, dirName: string): string {
  return publish(root, dirName, 'main');
}

function repoWithMaster(root: string, dirName: string): string {
  return publish(root, dirName, 'master');
}

function publish(root: string, dirName: string, branch: string): string {
  const clone = join(root, dirName);
  const remote = join(root, `${dirName}.git`);
  git(root, ['init', '-b', branch, clone]);
  commitFile(clone, 'README', `${dirName}\n`, dirName);
  git(root, ['init', '--bare', remote]);
  git(remote, ['symbolic-ref', 'HEAD', `refs/heads/${branch}`]);
  git(clone, ['remote', 'add', 'origin', remote]);
  git(clone, ['push', '-u', 'origin', branch]);
  return clone;
}

function repoWithBranch(root: string, dirName: string): string {
  const clone = publish(root, dirName, 'main');
  git(clone, ['checkout', '-b', 'feature/other']);
  commitFile(clone, 'NEXT', 'other\n', 'other');
  git(clone, ['push', '-u', 'origin', 'feature/other']);
  git(clone, ['checkout', '-b', 'dirty']);
  writeFileSync(join(clone, 'local.txt'), 'noise\n');
  return clone;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function hostFetch(rewrites: [string, string][]): () => void {
  const entries: [string, string][] = [['protocol.file.allow', 'always'], ...rewrites];
  const start = Number(process.env.GIT_CONFIG_COUNT);
  const base = Number.isInteger(start) && start > 0 ? start : 0;
  const savedCount = process.env.GIT_CONFIG_COUNT;
  const saved = entries.map((_, index) => {
    const slot = String(base + index);
    return { slot, key: process.env[`GIT_CONFIG_KEY_${slot}`], value: process.env[`GIT_CONFIG_VALUE_${slot}`] };
  });
  entries.forEach(([key, value], index) => {
    const slot = String(base + index);
    process.env[`GIT_CONFIG_KEY_${slot}`] = key;
    process.env[`GIT_CONFIG_VALUE_${slot}`] = value;
  });
  process.env.GIT_CONFIG_COUNT = String(base + entries.length);
  const previousSsh = process.env.GIT_SSH_COMMAND;
  process.env.GIT_SSH_COMMAND = 'false';
  return () => {
    if (savedCount === undefined) {
      delete process.env.GIT_CONFIG_COUNT;
    } else {
      process.env.GIT_CONFIG_COUNT = savedCount;
    }
    for (const item of saved) {
      if (item.key === undefined) {
        delete process.env[`GIT_CONFIG_KEY_${item.slot}`];
      } else {
        process.env[`GIT_CONFIG_KEY_${item.slot}`] = item.key;
      }
      if (item.value === undefined) {
        delete process.env[`GIT_CONFIG_VALUE_${item.slot}`];
      } else {
        process.env[`GIT_CONFIG_VALUE_${item.slot}`] = item.value;
      }
    }
    if (previousSsh === undefined) {
      delete process.env.GIT_SSH_COMMAND;
    } else {
      process.env.GIT_SSH_COMMAND = previousSsh;
    }
  };
}

function commitFile(cwd: string, name: string, body: string, message: string): void {
  writeFileSync(join(cwd, name), body);
  execFileSync('git', ['add', name], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  execFileSync('git', ['-c', 'user.email=dev@example.com', '-c', 'user.name=Dev', 'commit', '-m', message], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
