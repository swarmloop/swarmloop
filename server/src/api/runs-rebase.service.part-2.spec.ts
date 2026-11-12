import 'reflect-metadata';

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'fs';

import { mkdtemp, rm } from 'fs/promises';

import { tmpdir } from 'os';

import { isAbsolute, join } from 'path';

import { RunRepository } from '../history/run.repository';

import { DocumentRepository } from '../history/document.repository';

import { REBASE_CONFLICT, rebaseFeatureRepos, storedBase } from '../git/rebase';
import { memoryJournal } from '../git/rebase/journal.spec-helpers';

import { FakeClock } from '../core/fake-clock.spec-helpers';

import { RunRebaseService } from './run-rebase.service';

import { httpStatus } from './runs.controller';

import { boot, remember, featureWorktree, denyEnv, git } from '../testing/runs.spec-helpers';

// These specs diff the temp folder, so they use a folder of their own: jest workers share the real one.
jest.mock('os', () => {
  const actual = jest.requireActual<Record<string, unknown> & { tmpdir: () => string }>('os');
  return { ...actual, tmpdir: () => process.env.RUNS_REBASE_SPEC_TMP ?? actual.tmpdir() };
});

describe('runs api', () => {
  let ownTmp: string;

  beforeAll(async () => {
    ownTmp = await mkdtemp(join(tmpdir(), 'swarmloop-own-tmp-'));
    process.env.RUNS_REBASE_SPEC_TMP = ownTmp;
  });

  afterAll(async () => {
    delete process.env.RUNS_REBASE_SPEC_TMP;
    await rm(ownTmp, { recursive: true, force: true });
  });

  it('returns a conflict once and commits the resolution on the next call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-markers-'));
    const { tree, clone } = featureWorktree(root, 'proj-64');
    const branch = 'feature/proj-64-ship-the-field';
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    git(tree, ['add', 'src/field.ts']);
    git(tree, ['commit', '-m', 'field']);
    git(tree, ['push', '-u', 'origin', branch]);
    const oldTip = git(tree, ['rev-parse', 'HEAD']);
    const remoteTip = git(tree, ['rev-parse', `refs/remotes/origin/${branch}`]);
    git(clone, ['switch', 'main']);
    writeFileSync(join(clone, 'src', 'field.ts'), 'export const field = 2;\n');
    git(clone, ['add', 'src/field.ts']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['push', 'origin', 'main']);
    const base = git(clone, ['rev-parse', 'main']);
    const previous = process.env.SWARMLOOP_ROOT;
    process.env.SWARMLOOP_ROOT = root;
    const temps = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith('swarmloop-rebase-')));
    const input = {
      root,
      key: 'proj-64',
      repos: ['demo'],
      branch,
      prompt: null,
      denied: [],
      message: 'feat(proj-64): Ship the field',
      hosts: { GITLAB_BASE_URL: '', GITLAB_TOKEN: '', GITHUB_BASE_URL: '', GITHUB_TOKEN: '', clock: new FakeClock() },
      journal: memoryJournal(),
    };
    try {
      const stop = await rebaseFeatureRepos(input);
      expect(stop.kind).toBe('conflict');
      if (stop.kind === 'conflict') {
        expect(stop.files).toContain('src/field.ts');
        expect(stop.base).toBe('origin/main');
        expect(stop.commit).toBe('feat(proj-64): Ship the field');
      }
      const marked = readFileSync(join(tree, 'src', 'field.ts'), 'utf8');
      expect(marked).toContain('<<<<<<<');
      expect(marked).toContain('>>>>>>>');
      expect(git(tree, ['rev-parse', `refs/remotes/origin/${branch}`])).toBe(remoteTip);
      expect(git(tree, ['rev-parse', `refs/swarmloop/pre-rebase/${branch}`])).toBe(oldTip);
      expect(git(tree, ['branch', '--show-current'])).toBe(branch);
      expect(readdirSync(tmpdir()).filter((name) => name.startsWith('swarmloop-rebase-') && !temps.has(name))).toEqual(
        [],
      );
      const resolved = 'export const field = 3;\n<<<<<<<\n>>>>>>>\n';
      writeFileSync(join(tree, 'src', 'field.ts'), resolved);
      expect(git(tree, ['ls-files', '-u'])).toContain('src/field.ts');
      const next = await rebaseFeatureRepos(input);
      expect(next).toEqual({ kind: 'clean', leases: [{ repo: 'demo', tip: remoteTip }] });
      expect(git(tree, ['rev-parse', 'HEAD^'])).toBe(base);
      expect(git(tree, ['rev-list', '--count', `${base}..HEAD`])).toBe('1');
      expect(git(tree, ['log', '-1', '--format=%s'])).toBe('feat(proj-64): Ship the field');
      expect(readFileSync(join(tree, 'src', 'field.ts'), 'utf8')).toBe(resolved);
      expect(git(tree, ['show', 'HEAD:src/field.ts'])).toBe(resolved.trim());
      expect(git(tree, ['ls-files', '-u'])).not.toContain('src/field.ts');
      expect(git(tree, ['rev-parse', `refs/remotes/origin/${branch}`])).toBe(remoteTip);
      expect(readdirSync(tmpdir()).filter((name) => name.startsWith('swarmloop-rebase-') && !temps.has(name))).toEqual(
        [],
      );
    } finally {
      if (previous === undefined) {
        delete process.env.SWARMLOOP_ROOT;
      } else {
        process.env.SWARMLOOP_ROOT = previous;
      }
    }
  });

  it('finishes a rebase when skip-worktree hides different bytes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-skip-'));
    const { tree, clone } = featureWorktree(root, 'proj-63');
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    git(tree, ['add', 'src/field.ts']);
    git(tree, ['commit', '-m', 'field']);
    git(clone, ['switch', 'main']);
    writeFileSync(join(clone, 'src', 'base.ts'), 'export const base = 1;\n');
    git(clone, ['add', 'src/base.ts']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['push', 'origin', 'main']);
    const base = git(clone, ['rev-parse', 'main']);
    writeFileSync(join(tree, 'src', 'readme.ts'), 'export const readme = 9;\n');
    git(tree, ['update-index', '--skip-worktree', '--', 'src/readme.ts']);
    expect(git(tree, ['status', '--porcelain'])).toBe('');
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-63 started' }) };
    const app = await boot(root, pipeline);
    try {
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await remember(runs, documents, 'proj-63', 'done', 'done');
      await documents.putDocument(run, 'implementation', '- changed the field\n');
      const result = await app.get(RunRebaseService).rebase('proj-63');
      expect(result).toEqual({ key: 'proj-63', status: 'started' });
      expect(httpStatus(result)).toBe(202);
      expect(git(tree, ['rev-parse', 'HEAD^'])).toBe(base);
      expect(readFileSync(join(tree, 'src', 'readme.ts'), 'utf8')).toBe('export const readme = 1;\n');
      expect(git(tree, ['branch', '--show-current'])).toBe('feature/proj-63-ship-the-field');
    } finally {
      await app.close();
    }
  });

  it('returns a conflict when a tracked denied edit is hidden', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-denied-stash-'));
    const { tree, clone } = featureWorktree(root, 'proj-66');
    const branch = 'feature/proj-66-ship-the-field';
    writeFileSync(join(tree, '.env'), 'TOKEN=1\n');
    git(tree, ['add', '.env']);
    git(tree, ['commit', '-m', 'env']);
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    git(tree, ['add', 'src/field.ts']);
    git(tree, ['commit', '-m', 'field']);
    git(clone, ['switch', 'main']);
    writeFileSync(join(clone, 'src', 'field.ts'), 'export const field = 2;\n');
    git(clone, ['add', 'src/field.ts']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['push', 'origin', 'main']);
    writeFileSync(join(tree, '.env'), 'TOKEN=2\n');
    writeFileSync(join(tree, 'src', 'extra.ts'), 'export const extra = 1;\n');
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-66 started' }) };
    const app = await boot(root, pipeline);
    try {
      await denyEnv(app);
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await remember(runs, documents, 'proj-66', 'done', 'done');
      await documents.putDocument(run, 'implementation', '- changed the field\n');
      const result = await app.get(RunRebaseService).rebase('proj-66');
      expect(result).toEqual({ key: 'proj-66', status: 'started' });
      expect(httpStatus(result)).toBe(202);
      expect(pipeline.startDetached).toHaveBeenCalledWith('proj-66');
      const fresh = await runs.findRun('proj-66');
      expect(fresh?.status).toBe('waiting');
      expect(fresh?.currentStep).toBe('implement');
      expect((await documents.latestBody('proj-66', REBASE_CONFLICT))?.trim()).toBe('pending');
      expect(readFileSync(join(tree, 'src', 'field.ts'), 'utf8')).toContain('<<<<<<<');
      expect(git(tree, ['branch', '--show-current'])).toBe(branch);
      const state = git(tree, ['rev-parse', '--git-path', 'swarmloop-rebase']);
      expect(existsSync(isAbsolute(state) ? state : join(tree, state))).toBe(true);
      const saved = git(tree, ['rev-parse', `refs/swarmloop/pre-rebase/${branch}`]);
      expect(git(tree, ['show', '--name-only', '--format=', saved])).toContain('src/extra.ts');
      let hidden = false;
      try {
        git(tree, ['rev-parse', '--verify', '--quiet', 'refs/worktree/swarmloop-rebase']);
        hidden = true;
      } catch {
        hidden = false;
      }
      const env = existsSync(join(tree, '.env')) ? readFileSync(join(tree, '.env'), 'utf8') : '';
      expect(hidden || env.includes('TOKEN=2')).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('keeps a symlink and an auto-merged file when the squash conflicts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-symlink-'));
    const outside = join(root, 'outside.txt');
    const outsideDir = join(root, 'outside-dir');
    writeFileSync(outside, 'SECRET-OUTSIDE\n');
    mkdirSync(outsideDir);
    writeFileSync(join(outsideDir, 'keep.txt'), 'SECRET-DIR\n');
    const { tree, clone } = featureWorktree(root, 'proj-67');
    const branch = 'feature/proj-67-ship-the-field';
    git(clone, ['switch', 'main']);
    writeFileSync(join(clone, 'src', 'parts.ts'), 'export const a = 1;\nexport const mid = 1;\nexport const b = 1;\n');
    symlinkSync(outside, join(clone, 'src', 'hook.ts'));
    symlinkSync(outsideDir, join(clone, 'dir'));
    git(clone, ['add', 'src/parts.ts', 'src/hook.ts', 'dir']);
    git(clone, ['commit', '-m', 'parts']);
    git(clone, ['push', 'origin', 'main']);
    git(tree, ['fetch', 'origin', 'main']);
    git(tree, ['merge', '--ff-only', 'origin/main']);
    writeFileSync(join(tree, 'src', 'parts.ts'), 'export const a = 2;\nexport const mid = 1;\nexport const b = 1;\n');
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    symlinkSync(outside, join(tree, 'src', 'ext.ts'));
    unlinkSync(join(tree, 'src', 'hook.ts'));
    writeFileSync(join(tree, 'src', 'hook.ts'), 'export const hook = 1;\n');
    unlinkSync(join(tree, 'dir'));
    mkdirSync(join(tree, 'dir'));
    writeFileSync(join(tree, 'dir', 'inner.ts'), 'export const inner = 1;\n');
    git(tree, ['add', 'src/parts.ts', 'src/field.ts', 'src/ext.ts', 'src/hook.ts', 'dir/inner.ts']);
    git(tree, ['commit', '-m', 'feature']);
    writeFileSync(join(clone, 'src', 'parts.ts'), 'export const a = 1;\nexport const mid = 1;\nexport const b = 2;\n');
    writeFileSync(join(clone, 'src', 'field.ts'), 'export const field = 2;\n');
    git(clone, ['add', 'src/parts.ts', 'src/field.ts']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['push', 'origin', 'main']);
    const previous = process.env.SWARMLOOP_ROOT;
    process.env.SWARMLOOP_ROOT = root;
    const temps = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith('swarmloop-rebase-')));
    const input = {
      root,
      key: 'proj-67',
      repos: ['demo'],
      branch,
      prompt: null,
      denied: [],
      message: 'feat(proj-67): Ship the field',
      hosts: { GITLAB_BASE_URL: '', GITLAB_TOKEN: '', GITHUB_BASE_URL: '', GITHUB_TOKEN: '', clock: new FakeClock() },
      journal: memoryJournal(),
    };
    try {
      const stop = await rebaseFeatureRepos(input);
      expect(stop.kind).toBe('conflict');
      if (stop.kind === 'conflict') {
        expect(stop.files).toContain('src/field.ts');
        expect(stop.base).toBe('origin/main');
        expect(stop.commit).toBe('feat(proj-67): Ship the field');
      }
      expect(readFileSync(join(tree, 'src', 'field.ts'), 'utf8')).toContain('<<<<<<<');
      expect(readFileSync(join(tree, 'src', 'parts.ts'), 'utf8')).toBe(
        'export const a = 2;\nexport const mid = 1;\nexport const b = 2;\n',
      );
      expect(lstatSync(join(tree, 'src', 'ext.ts')).isSymbolicLink()).toBe(true);
      expect(readlinkSync(join(tree, 'src', 'ext.ts'))).toBe(outside);
      expect(lstatSync(join(tree, 'src', 'hook.ts')).isFile()).toBe(true);
      expect(readFileSync(join(tree, 'src', 'hook.ts'), 'utf8')).toBe('export const hook = 1;\n');
      expect(readFileSync(outside, 'utf8')).toBe('SECRET-OUTSIDE\n');
      expect(lstatSync(join(tree, 'dir')).isDirectory()).toBe(true);
      expect(readFileSync(join(tree, 'dir', 'inner.ts'), 'utf8')).toBe('export const inner = 1;\n');
      expect(existsSync(join(outsideDir, 'inner.ts'))).toBe(false);
      expect(readFileSync(join(outsideDir, 'keep.txt'), 'utf8')).toBe('SECRET-DIR\n');
      expect(git(tree, ['ls-files', '--stage', '--', 'src/ext.ts'])).toContain('120000');
      expect(readdirSync(tmpdir()).filter((name) => name.startsWith('swarmloop-rebase-') && !temps.has(name))).toEqual(
        [],
      );
    } finally {
      if (previous === undefined) {
        delete process.env.SWARMLOOP_ROOT;
      } else {
        process.env.SWARMLOOP_ROOT = previous;
      }
    }
  });

  it('rebases two worktrees of one repo at the same time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-parallel-'));
    const { tree, clone } = featureWorktree(root, 'proj-a');
    const treeB = join(root, 'worktrees', 'proj-b', 'demo');
    mkdirSync(join(treeB, '..'), { recursive: true });
    git(clone, ['worktree', 'add', '-b', 'feature/proj-b-ship-the-field', treeB, 'main']);
    writeFileSync(join(tree, 'src', 'a.ts'), 'export const a = 1;\n');
    git(tree, ['add', 'src/a.ts']);
    git(tree, ['commit', '-m', 'a']);
    writeFileSync(join(treeB, 'src', 'b.ts'), 'export const b = 1;\n');
    git(treeB, ['add', 'src/b.ts']);
    git(treeB, ['commit', '-m', 'b']);
    git(clone, ['switch', 'main']);
    writeFileSync(join(clone, 'src', 'base.ts'), 'export const base = 1;\n');
    git(clone, ['add', 'src/base.ts']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['push', 'origin', 'main']);
    const base = git(clone, ['rev-parse', 'main']);
    const previous = process.env.SWARMLOOP_ROOT;
    process.env.SWARMLOOP_ROOT = root;
    const hosts = {
      GITLAB_BASE_URL: '',
      GITLAB_TOKEN: '',
      GITHUB_BASE_URL: '',
      GITHUB_TOKEN: '',
      clock: new FakeClock(),
    };
    try {
      const [left, right] = await Promise.all([
        rebaseFeatureRepos({
          root,
          key: 'proj-a',
          repos: ['demo'],
          branch: 'feature/proj-a-ship-the-field',
          prompt: null,
          denied: [],
          message: 'feat(proj-a): Ship the field',
          hosts,
          journal: memoryJournal(),
        }),
        rebaseFeatureRepos({
          root,
          key: 'proj-b',
          repos: ['demo'],
          branch: 'feature/proj-b-ship-the-field',
          prompt: null,
          denied: [],
          message: 'feat(proj-b): Ship the field',
          hosts,
          journal: memoryJournal(),
        }),
      ]);
      expect(left).toEqual({ kind: 'clean', leases: [{ repo: 'demo', tip: null }] });
      expect(right).toEqual({ kind: 'clean', leases: [{ repo: 'demo', tip: null }] });
      expect(git(tree, ['rev-parse', 'HEAD^'])).toBe(base);
      expect(git(treeB, ['rev-parse', 'HEAD^'])).toBe(base);
      const filesA = git(tree, ['ls-tree', '-r', '--name-only', 'HEAD']);
      const filesB = git(treeB, ['ls-tree', '-r', '--name-only', 'HEAD']);
      expect(filesA).toContain('src/a.ts');
      expect(filesA).not.toContain('src/b.ts');
      expect(filesB).toContain('src/b.ts');
      expect(filesB).not.toContain('src/a.ts');
    } finally {
      if (previous === undefined) {
        delete process.env.SWARMLOOP_ROOT;
      } else {
        process.env.SWARMLOOP_ROOT = previous;
      }
    }
  });

  it('fetches one checkout from two prepares at the same time', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-fetch-'));
    const { clone } = featureWorktree(root, 'proj-fetch');
    const other = join(root, 'other');
    git(root, ['clone', '-b', 'main', join(root, 'demo.git'), other]);
    git(other, ['config', 'user.email', 'dev@example.com']);
    git(other, ['config', 'user.name', 'Dev']);
    writeFileSync(join(other, 'src', 'remote.ts'), 'export const remote = 1;\n');
    git(other, ['add', 'src/remote.ts']);
    git(other, ['commit', '-m', 'remote']);
    git(other, ['push', 'origin', 'HEAD:main']);
    const tip = git(join(root, 'demo.git'), ['rev-parse', 'refs/heads/main']);
    expect(git(clone, ['rev-parse', 'origin/main'])).not.toBe(tip);
    const previous = process.env.CHECKOUTS_ROOT;
    process.env.CHECKOUTS_ROOT = root;
    const hosts = {
      GITLAB_BASE_URL: '',
      GITLAB_TOKEN: '',
      GITHUB_BASE_URL: '',
      GITHUB_TOKEN: '',
      clock: new FakeClock(),
    };
    try {
      const refs = await Promise.all([
        storedBase(clone, 'demo', null, hosts, 'prepare'),
        storedBase(clone, 'demo', null, hosts, 'prepare'),
      ]);
      expect(refs).toEqual(['origin/main', 'origin/main']);
      expect(git(clone, ['rev-parse', 'origin/main'])).toBe(tip);
    } finally {
      if (previous === undefined) {
        delete process.env.CHECKOUTS_ROOT;
      } else {
        process.env.CHECKOUTS_ROOT = previous;
      }
    }
  });

  it('restores only the denied file hidden by that worktree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-hide-'));
    const { tree, clone } = featureWorktree(root, 'proj-a');
    git(clone, ['switch', 'main']);
    writeFileSync(join(clone, '.env'), 'TOKEN=0\n');
    git(clone, ['add', '.env']);
    git(clone, ['commit', '-m', 'env']);
    git(clone, ['push', 'origin', 'main']);
    git(tree, ['fetch', 'origin', 'main']);
    git(tree, ['merge', '--ff-only', 'origin/main']);
    const treeB = join(root, 'worktrees', 'proj-b', 'demo');
    mkdirSync(join(treeB, '..'), { recursive: true });
    git(clone, ['worktree', 'add', '-b', 'feature/proj-b-ship-the-field', treeB, 'main']);
    writeFileSync(join(tree, 'src', 'a.ts'), 'export const a = 1;\n');
    git(tree, ['add', 'src/a.ts']);
    git(tree, ['commit', '-m', 'a']);
    writeFileSync(join(treeB, 'src', 'b.ts'), 'export const b = 1;\n');
    git(treeB, ['add', 'src/b.ts']);
    git(treeB, ['commit', '-m', 'b']);
    writeFileSync(join(tree, '.env'), 'TOKEN=A\n');
    writeFileSync(join(treeB, '.env'), 'TOKEN=B\n');
    writeFileSync(join(clone, 'src', 'base.ts'), 'export const base = 1;\n');
    git(clone, ['add', 'src/base.ts']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['push', 'origin', 'main']);
    const base = git(clone, ['rev-parse', 'main']);
    const previous = process.env.SWARMLOOP_ROOT;
    process.env.SWARMLOOP_ROOT = root;
    const hosts = {
      GITLAB_BASE_URL: '',
      GITLAB_TOKEN: '',
      GITHUB_BASE_URL: '',
      GITHUB_TOKEN: '',
      clock: new FakeClock(),
    };
    const input = (key: string) => ({
      root,
      key,
      repos: ['demo'],
      branch: `feature/${key}-ship-the-field`,
      prompt: null,
      denied: ['.env'],
      message: `feat(${key}): Ship the field`,
      hosts,
      journal: memoryJournal(),
    });
    try {
      const [left, right] = await Promise.all([
        rebaseFeatureRepos(input('proj-a')),
        rebaseFeatureRepos(input('proj-b')),
      ]);
      expect(left.kind).toBe('clean');
      expect(right.kind).toBe('clean');
      expect(readFileSync(join(tree, '.env'), 'utf8')).toBe('TOKEN=A\n');
      expect(readFileSync(join(treeB, '.env'), 'utf8')).toBe('TOKEN=B\n');
      expect(git(tree, ['show', 'HEAD:.env'])).toBe('TOKEN=0');
      expect(git(treeB, ['show', 'HEAD:.env'])).toBe('TOKEN=0');
      expect(git(tree, ['rev-parse', 'HEAD^'])).toBe(base);
      expect(git(treeB, ['rev-parse', 'HEAD^'])).toBe(base);
      const filesA = git(tree, ['ls-tree', '-r', '--name-only', 'HEAD']);
      const filesB = git(treeB, ['ls-tree', '-r', '--name-only', 'HEAD']);
      expect(filesA).toContain('src/a.ts');
      expect(filesA).not.toContain('src/b.ts');
      expect(filesB).toContain('src/b.ts');
      expect(filesB).not.toContain('src/a.ts');
    } finally {
      if (previous === undefined) {
        delete process.env.SWARMLOOP_ROOT;
      } else {
        process.env.SWARMLOOP_ROOT = previous;
      }
    }
  });

  it('squashes a deletion of a tracked file onto a base that still has it', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-delete-'));
    const { tree, clone } = featureWorktree(root, 'proj-71');
    git(tree, ['rm', 'src/readme.ts']);
    git(clone, ['switch', 'main']);
    writeFileSync(join(clone, 'src', 'base.ts'), 'export const base = 1;\n');
    git(clone, ['add', 'src/base.ts']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['push', 'origin', 'main']);
    const base = git(clone, ['rev-parse', 'main']);
    const previous = process.env.SWARMLOOP_ROOT;
    process.env.SWARMLOOP_ROOT = root;
    try {
      const stop = await rebaseFeatureRepos({
        root,
        key: 'proj-71',
        repos: ['demo'],
        branch: 'feature/proj-71-ship-the-field',
        prompt: null,
        denied: [],
        message: 'feat(proj-71): Ship the field',
        hosts: { GITLAB_BASE_URL: '', GITLAB_TOKEN: '', GITHUB_BASE_URL: '', GITHUB_TOKEN: '', clock: new FakeClock() },
        journal: memoryJournal(),
      });
      expect(stop.kind).toBe('clean');
      expect(git(tree, ['rev-parse', 'HEAD^'])).toBe(base);
      expect(git(tree, ['diff', '--name-status', '--format=', 'HEAD^', 'HEAD'])).toContain('D\tsrc/readme.ts');
      expect(git(tree, ['ls-tree', '-r', '--name-only', 'HEAD'])).not.toContain('src/readme.ts');
      expect(git(tree, ['ls-tree', '-r', '--name-only', 'HEAD^'])).toContain('src/readme.ts');
    } finally {
      if (previous === undefined) {
        delete process.env.SWARMLOOP_ROOT;
      } else {
        process.env.SWARMLOOP_ROOT = previous;
      }
    }
  });
});
