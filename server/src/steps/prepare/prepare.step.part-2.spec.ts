import 'reflect-metadata';

import { getRepositoryToken } from '@nestjs/typeorm';

import { existsSync, mkdirSync } from 'fs';

import { mkdtemp } from 'fs/promises';

import { tmpdir } from 'os';

import { join } from 'path';

import type { Repository } from 'typeorm';

import { CheckoutEntity } from '../../history/entities';

import { RunRepository } from '../../history/run.repository';

import { DocumentRepository } from '../../history/document.repository';

import { PipelineService } from '../../pipeline/pipeline.service';

import { CheckoutService } from '../shared/checkout.service';

import {
  boot,
  seedRequirements,
  repoWithMain,
  repoWithMaster,
  repoWithBranch,
  git,
  hostFetch,
} from './prepare.step.spec-helpers';
import { storeRun } from '../../testing/store-run.spec-helpers';

describe('prepare step', () => {
  it('continues prepare when the previous process is gone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-prepare-dead-'));
    const clone = repoWithMain(root, 'clone');
    const app = await boot(root);
    try {
      await seedRequirements(app, 'PROJ-14');
      const runs = app.get(RunRepository);
      const seeded = await runs.findRun('PROJ-14');
      if (!seeded) {
        throw new Error('run is missing');
      }
      seeded.status = 'running';
      seeded.ownerPid = 2_147_483_646;
      seeded.ownerInstance = null;
      seeded.currentStep = 'prepare';
      await storeRun(runs, seeded);
      const checkouts = app.get<Repository<CheckoutEntity>>(getRepositoryToken(CheckoutEntity));
      await checkouts.save(checkouts.create({ name: 'demo', path: clone }));
      const result = await app.get(PipelineService).step('prepare', 'PROJ-14');
      expect(result.exitCode).toBe(0);
      expect(result.message).not.toContain('already running');
      expect(existsSync(join(root, 'worktrees', 'PROJ-14', 'demo'))).toBe(true);
      const run = await runs.findRun('PROJ-14');
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
      const runs = app.get(RunRepository);
      const run = await runs.findRun('PROJ-19');
      if (!run) {
        throw new Error('run is missing');
      }
      run.projects = 'app\n';
      run.prompt = 'branch: feature/missing\n';
      await storeRun(runs, run);
      const missing = await app.get(PipelineService).step('prepare', 'PROJ-19');
      expect(missing.exitCode).toBe(1);
      expect(missing.message).toContain('app has no origin/feature/missing');
      expect(missing.message).not.toContain('origin/main');
      expect(existsSync(join(swarm, 'worktrees', 'PROJ-19', 'app'))).toBe(false);
      expect(git(clone, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('dirty');

      run.prompt = 'branch: feature/a\nbranch: feature/b\n';
      run.status = 'waiting';
      await storeRun(runs, run);
      const ambiguous = await app.get(PipelineService).step('prepare', 'PROJ-19');
      expect(ambiguous.exitCode).toBe(1);
      expect(ambiguous.message).toContain('branch is ambiguous');

      run.prompt = 'Review the ticket\nbranch: feature/other\n';
      run.status = 'waiting';
      await storeRun(runs, run);
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
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const seeded = await runs.findRun('PROJ-40');
      if (!seeded) {
        throw new Error('run is missing');
      }
      seeded.projects = 'app\n';
      await storeRun(runs, seeded);
      expect((await app.get(PipelineService).step('prepare', 'PROJ-40')).exitCode).toBe(0);
      const worktree = join(swarm, 'worktrees', 'PROJ-40', 'app');
      expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(git(clone, ['rev-parse', 'origin/main']));

      seeded.prompt = 'branch: origin/feature/other\n';
      seeded.status = 'waiting';
      await storeRun(runs, seeded);
      expect((await app.get(PipelineService).step('prepare', 'PROJ-40')).exitCode).toBe(0);
      expect(git(worktree, ['rev-parse', 'HEAD'])).toBe(base);
      expect(git(clone, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('dirty');

      await documents.putDocument(
        seeded,
        'requirements',
        `${JSON.stringify({
          prompt: 'Ship the field\n',
          tickets: [
            { key: 'PROJ-40', summary: 'Ship the field', description: '', acceptanceCriteria: '', comments: [] },
          ],
          epic: null,
          epics: [],
          files: [],
          pages: [],
        })}\n`,
      );
      await documents.putDocument(seeded, 'repos', 'app\n');
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
    const restore = hostFetch([
      [`url.${join(root, 'demo.git')}.insteadOf`, `https://x-access-token:${token}@github.com/acme/demo.git`],
    ]);
    try {
      const app = await boot(root, undefined, { github: 'https://github.com', githubToken: token });
      try {
        await seedRequirements(app, 'PROJ-30');
        const checkouts = app.get<Repository<CheckoutEntity>>(getRepositoryToken(CheckoutEntity));
        await checkouts.save(checkouts.create({ name: 'demo', path: clone }));
        const result = await app.get(PipelineService).step('prepare', 'PROJ-30');
        expect(result.exitCode).toBe(0);
        expect(result.message).not.toContain(token);
        expect((await app.get(RunRepository).findRun('PROJ-30'))?.codeHost).toBe('github');
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
    const restore = hostFetch([
      [`url.${join(root, 'demo.git')}.insteadOf`, `https://oauth2:${token}@gitlab.example/group/demo.git`],
    ]);
    try {
      const app = await boot(root, undefined, { gitlab: 'https://gitlab.example', gitlabToken: token });
      try {
        await seedRequirements(app, 'PROJ-32');
        const checkouts = app.get<Repository<CheckoutEntity>>(getRepositoryToken(CheckoutEntity));
        await checkouts.save(checkouts.create({ name: 'demo', path: clone }));
        const result = await app.get(PipelineService).step('prepare', 'PROJ-32');
        expect(result.exitCode).toBe(0);
        expect(result.message).not.toContain(token);
        expect((await app.get(RunRepository).findRun('PROJ-32'))?.codeHost).toBe('gitlab');
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
        const runs = app.get(RunRepository);
        const run = await runs.findRun('PROJ-31');
        if (!run) {
          throw new Error('run is missing');
        }
        run.codeHost = 'github';
        await storeRun(runs, run);
        const checkouts = app.get<Repository<CheckoutEntity>>(getRepositoryToken(CheckoutEntity));
        await checkouts.save(checkouts.create({ name: 'web', path: web }));
        await checkouts.save(checkouts.create({ name: 'api', path: api }));
        const result = await app.get(PipelineService).step('prepare', 'PROJ-31');
        expect(result.exitCode).toBe(1);
        expect(result.message).toContain('origins use github and gitlab');
        expect(result.message).not.toContain(token);
        expect((await runs.findRun('PROJ-31'))?.codeHost).toBe('github');
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
    const restore = hostFetch([
      [`url.${join(root, 'demo.git')}.insteadOf`, `https://x-access-token:${token}@github.com/acme/demo.git`],
    ]);
    try {
      const app = await boot(root, undefined, { github: 'https://github.com', githubToken: token });
      try {
        await seedRequirements(app, 'PROJ-33');
        const runs = app.get(RunRepository);
        const run = await runs.findRun('PROJ-33');
        if (!run) {
          throw new Error('run is missing');
        }
        run.codeHost = 'gitlab';
        await storeRun(runs, run);
        const checkouts = app.get<Repository<CheckoutEntity>>(getRepositoryToken(CheckoutEntity));
        await checkouts.save(checkouts.create({ name: 'demo', path: clone }));
        const result = await app.get(PipelineService).step('prepare', 'PROJ-33');
        expect(result.exitCode).toBe(0);
        expect(result.message).not.toContain(token);
        expect((await runs.findRun('PROJ-33'))?.codeHost).toBe('github');
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
    const restore = hostFetch([
      [`url.${join(parent, 'other.git')}.insteadOf`, `https://oauth2:${token}@gitlab.example/group/other.git`],
    ]);
    try {
      const app = await boot(swarm, '..', {
        github: 'https://github.com',
        gitlab: 'https://gitlab.example',
        gitlabToken: token,
      });
      try {
        await seedRequirements(app, 'PROJ-34');
        const runs = app.get(RunRepository);
        const run = await runs.findRun('PROJ-34');
        if (!run) {
          throw new Error('run is missing');
        }
        run.codeHost = 'github';
        await storeRun(runs, run);
        await expect(app.get(CheckoutService).ensureDetached(run, ['other'], null, false)).rejects.toThrow(
          /origin is not github/,
        );
        expect((await runs.findRun('PROJ-34'))?.codeHost).toBe('github');
      } finally {
        await app.close();
      }
    } finally {
      restore();
    }
  });
});
