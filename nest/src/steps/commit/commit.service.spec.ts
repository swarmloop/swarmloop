import 'reflect-metadata';
import { execFileSync } from 'child_process';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { mkdtemp, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { Repository } from 'typeorm';
import { SwarmloopConfigModule } from '../../config/config.module';
import { DenyPathEntity } from '../../history/entities';
import { HistoryService } from '../../history/history.service';
import { PipelineModule } from '../../pipeline/pipeline.module';
import { PipelineService } from '../../pipeline/pipeline.service';
import { CI_SKIPPED, githubPushUrl, gitlabPushUrl } from './commit.service';

describe('commit step', () => {
  it('commits and pushes when ci is selected and origin exists', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-list-'));
    const tree = featureTree(root, 'PROJ-100');
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    writeFileSync(join(tree, 'src', 'readme.ts'), 'export const readme = 2;\n');
    writeFileSync(join(tree, '.env'), 'TOKEN=secret\n');
    const app = await boot(root);
    try {
      await seed(app, 'PROJ-100');
      const history = app.get(HistoryService);
      const seeded = await history.findRun('PROJ-100');
      if (!seeded) {
        throw new Error('run is missing');
      }
      await history.putDocument(seeded, 'ci_skip', `${CI_SKIPPED}\n`);
      const pushed = await app.get(PipelineService).step('commit', 'PROJ-100');
      expect(pushed.exitCode).toBe(0);
      expect(pushed.message).toContain('src/field.ts');
      expect(pushed.message).toContain('src/readme.ts');
      expect(pushed.message).not.toContain('.env');
      expect(git(tree, ['rev-list', '--count', 'HEAD'])).toBe('2');
      expect(git(tree, ['show', '--name-only', '--format=', 'HEAD'])).not.toContain('.env');
      expect(git(tree, ['status', '--porcelain'])).toContain('.env');
      expect(git(tree, ['rev-parse', 'HEAD'])).toBe(git(tree, ['rev-parse', 'origin/feature/PROJ-100-ship-the-field']));
      const run = await history.findRun('PROJ-100');
      expect(run?.currentStep).toBe('merge-request');
      expect(run?.status).toBe('waiting');
      expect(await history.latestBody('PROJ-100', 'ci_skip')).toContain(CI_SKIPPED);
    } finally {
      await app.close();
    }
  });

  it('commits when the repository pre-commit hook refuses', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-hook-'));
    const tree = featureTree(root, 'PROJ-114');
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    const hooks = join(tree, '.githooks');
    mkdirSync(hooks);
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\necho pre-commit refused >&2\nexit 1\n');
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    git(tree, ['config', 'core.hooksPath', '.githooks']);
    const app = await boot(root);
    try {
      await seed(app, 'PROJ-114');
      const pushed = await app.get(PipelineService).step('commit', 'PROJ-114');
      expect(pushed.exitCode).toBe(0);
      expect(pushed.message).not.toContain('pre-commit refused');
      expect(git(tree, ['rev-list', '--count', 'HEAD'])).toBe('2');
      expect(git(tree, ['show', '--name-only', '--format=', 'HEAD'])).toContain('src/field.ts');
    } finally {
      await app.close();
    }
  });

  it('still waits for a person when ci was not selected', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-wait-'));
    const tree = featureTree(root, 'PROJ-108');
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    const app = await boot(root);
    try {
      await seed(app, 'PROJ-108');
      await app.get(HistoryService).noteFlow('PROJ-108', ['code-review'], null);
      const listed = await app.get(PipelineService).step('commit', 'PROJ-108');
      expect(listed.exitCode).toBe(0);
      expect(listed.message).toContain('src/field.ts');
      expect(git(tree, ['rev-list', '--count', 'HEAD'])).toBe('1');
      const run = await app.get(HistoryService).findRun('PROJ-108');
      expect(run?.currentStep).toBe('commit');
      expect(run?.status).toBe('waiting');
    } finally {
      await app.close();
    }
  });

  it('commits locally and leaves the push for later when origin is missing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-local-'));
    const tree = featureTree(root, 'PROJ-109');
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    writeFileSync(join(tree, '.env'), 'TOKEN=secret\n');
    git(tree, ['remote', 'remove', 'origin']);
    const app = await boot(root);
    try {
      await seed(app, 'PROJ-109');
      const committed = await app.get(PipelineService).step('commit', 'PROJ-109');
      expect(committed.exitCode).toBe(0);
      expect(committed.message).toContain(CI_SKIPPED);
      expect(committed.message).toContain('src/field.ts');
      expect(committed.message).not.toContain('.env');
      expect(git(tree, ['rev-list', '--count', 'HEAD'])).toBe('2');
      expect(git(tree, ['show', '--name-only', '--format=', 'HEAD'])).not.toContain('.env');
      expect(git(tree, ['status', '--porcelain'])).toContain('.env');
      expect(await app.get(HistoryService).latestBody('PROJ-109', 'ci_skip')).toContain(CI_SKIPPED);
      const skipped = await app.get(PipelineService).runThrough('PROJ-109');
      expect(skipped.exitCode).toBe(0);
      expect(skipped.message).toContain(CI_SKIPPED);
      const run = await app.get(HistoryService).findRun('PROJ-109');
      expect(run?.currentStep).toBe('done');
      expect(run?.status).toBe('done');
      const stats = await app.get(HistoryService).listStats(run?.id ?? 0);
      expect(stats.some((stat) => stat.step === 'pipeline' && stat.status === 'skipped')).toBe(true);
      expect(stats.some((stat) => stat.step === 'merge-request' && stat.status === 'done')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('commits files that showed up after an earlier commit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-later-'));
    const tree = featureTree(root, 'PROJ-115');
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    const app = await boot(root);
    try {
      await seed(app, 'PROJ-115');
      const history = app.get(HistoryService);
      const first = await app.get(PipelineService).step('commit', 'PROJ-115');
      expect(first.exitCode).toBe(0);
      expect(git(tree, ['rev-list', '--count', 'HEAD'])).toBe('2');
      const run = await history.findRun('PROJ-115');
      if (!run) {
        throw new Error('run is missing');
      }
      run.status = 'waiting';
      run.currentStep = 'commit';
      await history.saveRun(run);
      writeFileSync(join(tree, 'src', 'extra.ts'), 'export const extra = 1;\n');
      const second = await app.get(PipelineService).step('commit', 'PROJ-115');
      expect(second.exitCode).toBe(0);
      expect(second.message).toContain('src/extra.ts');
      expect(git(tree, ['rev-list', '--count', 'HEAD'])).toBe('3');
      expect(git(tree, ['show', '--name-only', '--format=', 'HEAD'])).toContain('src/extra.ts');
    } finally {
      await app.close();
    }
  });

  it('does not create a second commit when the paths are already committed', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-again-'));
    const tree = featureTree(root, 'PROJ-102');
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    const app = await boot(root);
    try {
      await seed(app, 'PROJ-102');
      const remote = git(tree, ['remote', 'get-url', 'origin']);
      git(tree, ['remote', 'set-url', 'origin', join(root, 'missing.git')]);
      const failed = await app.get(PipelineService).step('commit', 'PROJ-102');
      expect(failed.exitCode).toBe(1);
      expect(failed.message).toContain('push failed');
      expect(git(tree, ['rev-list', '--count', 'HEAD'])).toBe('2');
      git(tree, ['remote', 'set-url', 'origin', remote]);
      const again = await app.get(PipelineService).step('commit', 'PROJ-102');
      expect(again.exitCode).toBe(0);
      expect(git(tree, ['rev-list', '--count', 'HEAD'])).toBe('2');
      expect(git(tree, ['rev-parse', 'HEAD'])).toBe(git(tree, ['rev-parse', 'origin/feature/PROJ-102-ship-the-field']));
      expect((await app.get(HistoryService).findRun('PROJ-102'))?.currentStep).toBe('merge-request');
    } finally {
      await app.close();
    }
  });

  it('pushes a commit that already exists and does not add another', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-ahead-'));
    const tree = featureTree(root, 'PROJ-105');
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    git(tree, ['add', 'src/field.ts']);
    git(tree, ['commit', '-m', 'already']);
    const app = await boot(root);
    try {
      await seed(app, 'PROJ-105');
      const pushed = await app.get(PipelineService).step('commit', 'PROJ-105');
      expect(pushed.exitCode).toBe(0);
      expect(pushed.message).not.toContain('nothing to commit');
      expect(git(tree, ['rev-list', '--count', 'HEAD'])).toBe('2');
      expect(git(tree, ['rev-parse', 'HEAD'])).toBe(git(tree, ['rev-parse', 'origin/feature/PROJ-105-ship-the-field']));
    } finally {
      await app.close();
    }
  });

  it('finishes when the branch already matches origin', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-published-'));
    const tree = featureTree(root, 'PROJ-114');
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    git(tree, ['add', 'src/field.ts']);
    git(tree, ['commit', '-m', 'already']);
    git(tree, ['push', '-u', 'origin', 'feature/PROJ-114-ship-the-field']);
    const app = await boot(root);
    try {
      await seed(app, 'PROJ-114');
      const history = app.get(HistoryService);
      const before = await history.latestBody('PROJ-114', 'pipeline_ref');
      const done = await app.get(PipelineService).step('commit', 'PROJ-114');
      expect(done.exitCode).toBe(0);
      expect(done.message).toContain('commit done');
      expect(done.message).not.toContain('nothing to commit');
      expect(done.message).not.toContain(CI_SKIPPED);
      expect(await history.latestBody('PROJ-114', 'ci_skip')).toBeNull();
      expect(await history.latestBody('PROJ-114', 'pipeline_ref')).toBe(before);
      expect(git(tree, ['rev-list', '--count', 'HEAD'])).toBe('2');
    } finally {
      await app.close();
    }
  });

  it('does not stage a denied file inside a new directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-nested-'));
    const tree = featureTree(root, 'PROJ-106');
    mkdirSync(join(tree, 'fresh'), { recursive: true });
    writeFileSync(join(tree, 'fresh', 'keep.ts'), 'export const keep = 1;\n');
    writeFileSync(join(tree, 'fresh', '.env'), 'TOKEN=secret\n');
    const app = await boot(root);
    try {
      await seed(app, 'PROJ-106');
      const pushed = await app.get(PipelineService).step('commit', 'PROJ-106');
      expect(pushed.exitCode).toBe(0);
      expect(pushed.message).toContain('fresh/keep.ts');
      expect(pushed.message).not.toContain('.env');
      const names = git(tree, ['show', '--name-only', '--format=', 'HEAD']);
      expect(names).toContain('fresh/keep.ts');
      expect(names).not.toContain('.env');
      expect(git(tree, ['status', '--porcelain'])).toContain('.env');
    } finally {
      await app.close();
    }
  });

  it('builds a gitlab https push url from ssh origin', () => {
    expect(gitlabPushUrl('git@gitlab.example:group/demo.git', 'https://gitlab.example', 'tok')).toBe(
      'https://oauth2:tok@gitlab.example/group/demo.git',
    );
    expect(gitlabPushUrl('/tmp/demo.git', 'https://gitlab.example', 'tok')).toBeNull();
  });

  it('builds a github https push url from ssh origin', () => {
    expect(githubPushUrl('git@github.com:acme/demo.git', 'https://github.com', 'tok')).toBe(
      'https://x-access-token:tok@github.com/acme/demo.git',
    );
    expect(githubPushUrl('git@gitlab.example:group/demo.git', 'https://github.com', 'tok')).toBeNull();
  });

  it('names a missing token when origin is ssh', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-ssh-'));
    const tree = featureTree(root, 'PROJ-110');
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    git(tree, ['remote', 'set-url', 'origin', 'git@gitlab.example:group/demo.git']);
    const app = await boot(root);
    try {
      await seed(app, 'PROJ-110', 'gitlab');
      const result = await app.get(PipelineService).step('commit', 'PROJ-110');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('GITLAB_TOKEN is missing');
      expect(git(tree, ['rev-list', '--count', 'HEAD'])).toBe('2');
    } finally {
      await app.close();
    }
  });

  it('names a missing github token when origin is ssh', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-github-'));
    const tree = featureTree(root, 'PROJ-112');
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    git(tree, ['remote', 'set-url', 'origin', 'git@github.com:acme/demo.git']);
    const app = await boot(root, 'github');
    try {
      await seed(app, 'PROJ-112', 'github');
      const result = await app.get(PipelineService).step('commit', 'PROJ-112');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('GITHUB_TOKEN is missing');
      expect(result.message).not.toContain('GITLAB_TOKEN');
    } finally {
      await app.close();
    }
  });

  it('uses GIT_AUTHOR_* when the repo has no identity', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-author-'));
    const tree = featureTree(root, 'PROJ-111');
    git(tree, ['config', '--unset-all', 'user.email']);
    git(tree, ['config', '--unset-all', 'user.name']);
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    const previousName = process.env.GIT_AUTHOR_NAME;
    const previousEmail = process.env.GIT_AUTHOR_EMAIL;
    process.env.GIT_AUTHOR_NAME = 'Ada Lovelace';
    process.env.GIT_AUTHOR_EMAIL = 'ada@example.com';
    const app = await boot(root);
    try {
      await seed(app, 'PROJ-111');
      const result = await app.get(PipelineService).step('commit', 'PROJ-111');
      expect(result.exitCode).toBe(0);
      expect(git(tree, ['log', '-1', '--format=%an <%ae>'])).toBe('Ada Lovelace <ada@example.com>');
    } finally {
      if (previousName === undefined) {
        delete process.env.GIT_AUTHOR_NAME;
      } else {
        process.env.GIT_AUTHOR_NAME = previousName;
      }
      if (previousEmail === undefined) {
        delete process.env.GIT_AUTHOR_EMAIL;
      } else {
        process.env.GIT_AUTHOR_EMAIL = previousEmail;
      }
      await app.close();
    }
  });

  it('refuses a protected branch', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-main-'));
    const tree = featureTree(root, 'PROJ-103');
    git(tree, ['switch', 'main']);
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    const app = await boot(root);
    try {
      await seed(app, 'PROJ-103');
      const result = await app.get(PipelineService).step('commit', 'PROJ-103');
      expect(result.exitCode).toBe(1);
      expect(result.message).toContain('branch is protected');
      expect(git(tree, ['rev-list', '--count', 'HEAD'])).toBe('1');
      expect((await app.get(HistoryService).findRun('PROJ-103'))?.currentStep).toBe('commit');
    } finally {
      await app.close();
    }
  });

  it('pushes a rewritten feature branch with force-with-lease', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-lease-'));
    const tree = featureTree(root, 'PROJ-111');
    const branch = 'feature/PROJ-111-ship-the-field';
    git(tree, ['push', '-u', 'origin', branch]);
    git(tree, ['commit', '--amend', '--no-edit', '--date', '2000-01-02T00:00:00Z']);
    const amended = git(tree, ['rev-parse', 'HEAD']);
    expect(amended).not.toBe(git(tree, ['rev-parse', `origin/${branch}`]));
    const app = await boot(root);
    try {
      await seed(app, 'PROJ-111');
      const pushed = await app.get(PipelineService).step('commit', 'PROJ-111');
      expect(pushed.exitCode).toBe(0);
      expect(git(tree, ['rev-parse', 'HEAD'])).toBe(amended);
      expect(git(tree, ['rev-parse', `origin/${branch}`])).toBe(amended);
    } finally {
      await app.close();
    }
  });

  it('leases the stored feature tip when the push goes to the host url', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-lease-url-'));
    const tree = featureTree(root, 'PROJ-112');
    const branch = 'feature/PROJ-112-ship-the-field';
    const bare = join(root, 'demo.git');
    const token = 'lease-token';
    git(tree, ['push', '-u', 'origin', branch]);
    git(tree, ['commit', '--amend', '--no-edit', '--date', '2000-01-02T00:00:00Z']);
    const amended = git(tree, ['rev-parse', 'HEAD']);
    git(tree, ['remote', 'set-url', 'origin', 'git@gitlab.example:group/demo.git']);
    const restore = hostPush(bare, token);
    try {
      const app = await boot(root, 'gitlab', { baseUrl: 'https://gitlab.example', token });
      try {
        await seed(app, 'PROJ-112', 'gitlab');
        const history = app.get(HistoryService);
        const seeded = await history.findRun('PROJ-112');
        if (!seeded) {
          throw new Error('run is missing');
        }
        await history.putDocument(seeded, 'ci_skip', `${CI_SKIPPED}\n`);
        const pushed = await app.get(PipelineService).step('commit', 'PROJ-112');
        expect(pushed.exitCode).toBe(0);
        expect(git(tree, ['rev-parse', 'HEAD'])).toBe(amended);
        expect(git(bare, ['rev-parse', `refs/heads/${branch}`])).toBe(amended);
        expect((await history.latestBody('PROJ-112', 'ci_skip'))?.trim() ?? '').toBe('');
      } finally {
        await app.close();
      }
    } finally {
      restore();
    }
  });

  it('does not replace a feature branch that moved past the stored tip', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-lease-moved-'));
    const tree = featureTree(root, 'PROJ-113');
    const branch = 'feature/PROJ-113-ship-the-field';
    const bare = join(root, 'demo.git');
    const token = 'lease-token';
    git(tree, ['push', '-u', 'origin', branch]);
    const stored = git(tree, ['rev-parse', `origin/${branch}`]);
    const other = join(root, 'other');
    git(root, ['clone', bare, other]);
    git(other, ['config', 'user.email', 'dev@example.com']);
    git(other, ['config', 'user.name', 'Dev']);
    git(other, ['switch', '-c', 'extra', `origin/${branch}`]);
    writeFileSync(join(other, 'src', 'remote.ts'), 'export const remote = 1;\n');
    git(other, ['add', 'src/remote.ts']);
    git(other, ['commit', '-m', 'remote']);
    git(other, ['push', 'origin', `HEAD:${branch}`]);
    expect(git(tree, ['rev-parse', `origin/${branch}`])).toBe(stored);
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    git(tree, ['remote', 'set-url', 'origin', 'git@gitlab.example:group/demo.git']);
    const restore = hostPush(bare, token);
    try {
      const app = await boot(root, 'gitlab', { baseUrl: 'https://gitlab.example', token });
      try {
        await seed(app, 'PROJ-113', 'gitlab');
        const rejected = await app.get(PipelineService).step('commit', 'PROJ-113');
        expect(rejected.exitCode).toBe(1);
        expect(rejected.message).toContain('push failed');
        expect(git(bare, ['rev-parse', `refs/heads/${branch}`])).toBe(git(other, ['rev-parse', 'HEAD']));
      } finally {
        await app.close();
      }
    } finally {
      restore();
    }
  });

  it('commits a staged deletion and a staged rename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-commit-rename-'));
    const tree = featureTree(root, 'PROJ-120');
    writeFileSync(join(tree, 'src', 'old.ts'), 'export const old = 1;\n');
    git(tree, ['add', 'src/old.ts']);
    git(tree, ['commit', '-m', 'track']);
    git(tree, ['rm', 'src/readme.ts']);
    git(tree, ['mv', 'src/old.ts', 'src/new.ts']);
    writeFileSync(join(tree, '.env'), 'TOKEN=1\n');
    git(tree, ['add', '.env']);
    const app = await boot(root);
    try {
      await seed(app, 'PROJ-120');
      const committed = await app.get(PipelineService).step('commit', 'PROJ-120');
      expect(committed.exitCode).toBe(0);
      expect(committed.message).not.toContain('pathspec');
      const files = git(tree, ['ls-tree', '-r', '--name-only', 'HEAD']);
      expect(files).toContain('src/new.ts');
      expect(files).not.toContain('src/old.ts');
      expect(files).not.toContain('src/readme.ts');
      expect(files).not.toContain('.env');
      expect(git(tree, ['status', '--porcelain'])).toContain('.env');
      expect(readFileSync(join(tree, 'src', 'new.ts'), 'utf8')).toBe('export const old = 1;\n');
      expect(existsSync(join(tree, 'src', 'readme.ts'))).toBe(false);
      expect(existsSync(join(tree, 'src', 'old.ts'))).toBe(false);
      expect(git(tree, ['diff', '--name-status', '--format=', 'HEAD^', 'HEAD'])).toContain('src/readme.ts');
    } finally {
      await app.close();
    }
  });

});

async function boot(root: string, codeHost = 'gitlab', host: { baseUrl?: string; token?: string } = {}) {
  await writeFile(
    join(root, '.env'),
    [
      'RUNTIME=cursor',
      'REQUIREMENTS_VIA=direct',
      'ISSUE_TRACKER=jira',
      'JIRA_BASE_URL=',
      'JIRA_EMAIL=',
      'JIRA_API_TOKEN=',
      `GITLAB_BASE_URL=${codeHost === 'gitlab' ? (host.baseUrl ?? '') : ''}`,
      `GITLAB_TOKEN=${codeHost === 'gitlab' ? (host.token ?? '') : ''}`,
      `GITHUB_BASE_URL=${codeHost === 'github' ? (host.baseUrl ?? '') : ''}`,
      `GITHUB_TOKEN=${codeHost === 'github' ? (host.token ?? '') : ''}`,
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
      '',
    ].join('\n'),
  );
  const app = await Test.createTestingModule({
    imports: [SwarmloopConfigModule.forRoot(join(root, '.env')), PipelineModule],
  }).compile();
  const deny = app.get<Repository<DenyPathEntity>>(getRepositoryToken(DenyPathEntity));
  await deny.save(deny.create({ pattern: '.env' }));
  return app;
}

async function seed(app: Awaited<ReturnType<typeof boot>>, key: string, codeHost = ''): Promise<void> {
  const history = app.get(HistoryService);
  const seeded = await history.begin(key, 'commit');
  seeded.status = 'waiting';
  seeded.currentStep = 'code-review';
  seeded.codeHost = codeHost;
  await history.saveRun(seeded);
  await history.putDocument(
    seeded,
    'requirements',
    `${JSON.stringify({
      prompt: 'Ship the field\n',
      tickets: [{ key, summary: 'Ship the field', description: '', acceptanceCriteria: '', comments: [] }],
      epic: null,
      epics: [],
      files: [],
      pages: [],
    })}\n`,
  );
  await history.putDocument(seeded, 'repos', 'demo\n');
}

function featureTree(root: string, key: string): string {
  const clone = join(root, 'demo');
  const remote = join(root, 'demo.git');
  const tree = join(root, 'worktrees', key, 'demo');
  git(root, ['init', '-b', 'main', clone]);
  git(clone, ['config', 'user.email', 'dev@example.com']);
  git(clone, ['config', 'user.name', 'Dev']);
  mkdirSync(join(clone, 'src'), { recursive: true });
  writeFileSync(join(clone, 'src', 'readme.ts'), 'export const readme = 1;\n');
  git(clone, ['add', 'src/readme.ts']);
  git(clone, ['commit', '-m', 'init']);
  git(root, ['init', '--bare', remote]);
  git(clone, ['remote', 'add', 'origin', remote]);
  git(clone, ['push', '-u', 'origin', 'main']);
  git(clone, ['switch', '-c', 'holder']);
  mkdirSync(join(tree, '..'), { recursive: true });
  git(clone, ['worktree', 'add', '-b', `feature/${key}-ship-the-field`, tree, 'main']);
  return tree;
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function hostPush(bare: string, token: string): () => void {
  const entries = [
    ['protocol.file.allow', 'always'],
    [`url.${bare}.insteadOf`, `https://oauth2:${token}@gitlab.example/group/demo.git`],
    [`url.${bare}.insteadOf`, 'https://gitlab.example/group/demo.git'],
  ];
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
  };
}
