import 'reflect-metadata';

import { existsSync, readFileSync, writeFileSync } from 'fs';

import { mkdtemp } from 'fs/promises';

import { tmpdir } from 'os';

import { isAbsolute, join } from 'path';

import { rebaseFeatureRepos } from '../git/rebase';
import { CommandService } from '../pipeline/command.service';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { hostConflictMarker } from '../steps/shared/host-conflict-marker';
import { RunRebaseService } from './run-rebase.service';
import { CommandHandlers } from './command-handlers';
import { seededBoot } from './runs-boot.spec-helpers';
import { memoryJournal } from '../git/rebase/journal.spec-helpers';

import { FakeClock } from '../core/fake-clock.spec-helpers';

import { featureWorktree, git, remember } from '../testing/runs.spec-helpers';

async function rebaseDemo(root: string, key: string, branch: string, denied: string[]) {
  const previous = process.env.SWARMLOOP_ROOT;
  process.env.SWARMLOOP_ROOT = root;
  try {
    return await rebaseFeatureRepos({
      root,
      key,
      repos: ['demo'],
      branch,
      prompt: null,
      denied,
      message: `feat(${key}): Ship the field`,
      hosts: { GITLAB_BASE_URL: '', GITLAB_TOKEN: '', GITHUB_BASE_URL: '', GITHUB_TOKEN: '', clock: new FakeClock() },
      journal: memoryJournal(),
    });
  } finally {
    if (previous === undefined) {
      delete process.env.SWARMLOOP_ROOT;
    } else {
      process.env.SWARMLOOP_ROOT = previous;
    }
  }
}

describe('runs api', () => {
  it('commits a parked index deletion and clears the marker', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-resume-delete-'));
    const { tree } = featureWorktree(root, 'proj-72');
    const base = git(tree, ['rev-parse', 'origin/main']);
    const state = git(tree, ['rev-parse', '--git-path', 'swarmloop-rebase']);
    const marker = isAbsolute(state) ? state : join(tree, state);
    writeFileSync(marker, `${base}\nfeat(proj-72): Ship the field\n`);
    git(tree, ['rm', 'src/readme.ts']);
    writeFileSync(join(tree, '.env'), 'TOKEN=1\n');
    git(tree, ['add', '.env']);
    const previous = process.env.SWARMLOOP_ROOT;
    process.env.SWARMLOOP_ROOT = root;
    try {
      const stop = await rebaseFeatureRepos({
        root,
        key: 'proj-72',
        repos: ['demo'],
        branch: 'feature/proj-72-ship-the-field',
        prompt: null,
        denied: ['.env'],
        message: 'feat(proj-72): Ship the field',
        hosts: { GITLAB_BASE_URL: '', GITLAB_TOKEN: '', GITHUB_BASE_URL: '', GITHUB_TOKEN: '', clock: new FakeClock() },
        journal: memoryJournal(),
      });
      expect(stop).toEqual({ kind: 'clean', leases: [{ repo: 'demo', tip: null }] });
      expect(existsSync(marker)).toBe(false);
      expect(git(tree, ['log', '-1', '--format=%s'])).toBe('feat(proj-72): Ship the field');
      expect(git(tree, ['diff', '--name-status', '--format=', 'HEAD^', 'HEAD'])).toContain('D\tsrc/readme.ts');
      expect(git(tree, ['ls-tree', '-r', '--name-only', 'HEAD'])).not.toContain('src/readme.ts');
      expect(git(tree, ['ls-tree', '-r', '--name-only', 'HEAD'])).not.toContain('.env');
      expect(git(tree, ['status', '--porcelain'])).toContain('.env');
      expect(readFileSync(join(tree, '.env'), 'utf8')).toBe('TOKEN=1\n');
    } finally {
      if (previous === undefined) {
        delete process.env.SWARMLOOP_ROOT;
      } else {
        process.env.SWARMLOOP_ROOT = previous;
      }
    }
  });

  it('squashes a staged rename onto the new base', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-rename-'));
    const { tree, clone } = featureWorktree(root, 'proj-73');
    git(tree, ['mv', 'src/readme.ts', 'src/guide.ts']);
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
        key: 'proj-73',
        repos: ['demo'],
        branch: 'feature/proj-73-ship-the-field',
        prompt: null,
        denied: [],
        message: 'feat(proj-73): Ship the field',
        hosts: { GITLAB_BASE_URL: '', GITLAB_TOKEN: '', GITHUB_BASE_URL: '', GITHUB_TOKEN: '', clock: new FakeClock() },
        journal: memoryJournal(),
      });
      expect(stop.kind).toBe('clean');
      expect(git(tree, ['rev-parse', 'HEAD^'])).toBe(base);
      const files = git(tree, ['ls-tree', '-r', '--name-only', 'HEAD']);
      expect(files).toContain('src/guide.ts');
      expect(files).not.toContain('src/readme.ts');
      expect(git(tree, ['ls-tree', '-r', '--name-only', 'HEAD^'])).toContain('src/readme.ts');
      expect(readFileSync(join(tree, 'src', 'guide.ts'), 'utf8')).toBe('export const readme = 1;\n');
      expect(existsSync(join(tree, 'src', 'readme.ts'))).toBe(false);
    } finally {
      if (previous === undefined) {
        delete process.env.SWARMLOOP_ROOT;
      } else {
        process.env.SWARMLOOP_ROOT = previous;
      }
    }
  });

  it('commits allowed dirt before rebase and leaves .env unstaged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-commit-'));
    const { tree, clone } = featureWorktree(root, 'proj-52');
    writeFileSync(join(tree, 'src', 'dirty.ts'), 'export const dirty = 1;\n');
    writeFileSync(join(tree, '.env'), 'TOKEN=secret\n');
    git(clone, ['switch', 'main']);
    writeFileSync(join(clone, 'src', 'base.ts'), 'export const base = 1;\n');
    git(clone, ['add', 'src/base.ts']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['push', 'origin', 'main']);
    const base = git(clone, ['rev-parse', 'main']);
    const stop = await rebaseDemo(root, 'proj-52', 'feature/proj-52-ship-the-field', ['.env']);
    expect(stop.kind).toBe('clean');
    const names = git(tree, ['show', '--name-only', '--format=', 'HEAD']);
    expect(names).toContain('src/dirty.ts');
    expect(names).not.toContain('.env');
    expect(git(tree, ['status', '--porcelain'])).toContain('.env');
    git(tree, ['merge-base', '--is-ancestor', base, 'HEAD']);
    expect(git(tree, ['branch', '--show-current'])).toBe('feature/proj-52-ship-the-field');
  });

  it('leaves a done run unchanged when only a denied path is dirty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-denied-'));
    const { tree } = featureWorktree(root, 'proj-53');
    writeFileSync(join(tree, '.env'), 'TOKEN=1\n');
    git(tree, ['add', '.env']);
    git(tree, ['commit', '-m', 'env']);
    writeFileSync(join(tree, '.env'), 'TOKEN=2\n');
    const head = git(tree, ['rev-parse', 'HEAD']);
    await expect(rebaseDemo(root, 'proj-53', 'feature/proj-53-ship-the-field', ['.env'])).rejects.toThrow(
      'demo rebase failed',
    );
    expect(git(tree, ['rev-parse', 'HEAD'])).toBe(head);
    expect(git(tree, ['status', '--porcelain'])).toContain('.env');
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
    const stop = await rebaseDemo(root, 'proj-66', branch, ['.env']);
    expect(stop.kind).toBe('conflict');
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
  });

  describe('a conflict only the code host sees', () => {
    const text = 'The pull request has merge conflicts with its base branch.';

    async function bootDone(key: string) {
      const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-host-'));
      const fixture = featureWorktree(root, key);
      const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: `${key} started` }) };
      const app = await seededBoot(root, pipeline);
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await remember(runs, documents, key, 'pipeline', 'done');
      await documents.putDocument(run, 'implementation', '- changed the field\n');
      return { ...fixture, app, runs, documents };
    }

    it('hands the conflict to implement when the move leaves the head where it was', async () => {
      const { tree, app, runs, documents } = await bootDone('proj-81');
      try {
        const head = git(tree, ['rev-parse', 'HEAD']);
        await app.get(RunRebaseService).rebase('proj-81', false, undefined, false, text);
        const run = await runs.findRun('proj-81');
        expect(run?.currentStep).toBe('implement');
        expect(run?.status).toBe('waiting');
        expect(await documents.latestBody('proj-81', 'rebase_conflict')).toBe(hostConflictMarker(text));
        expect(git(tree, ['rev-parse', 'HEAD'])).toBe(head);
      } finally {
        await app.close();
      }
    });

    it('goes to code review as today when the base moved and the head moved', async () => {
      const { tree, clone, app, runs, documents } = await bootDone('proj-82');
      try {
        const head = git(tree, ['rev-parse', 'HEAD']);
        git(clone, ['switch', 'main']);
        writeFileSync(join(clone, 'src', 'base.ts'), 'export const base = 1;\n');
        git(clone, ['add', 'src/base.ts']);
        git(clone, ['commit', '-m', 'base']);
        git(clone, ['push', 'origin', 'main']);
        await app.get(RunRebaseService).rebase('proj-82', false, undefined, false, text);
        expect((await runs.findRun('proj-82'))?.currentStep).toBe('code-review');
        expect(await documents.latestBody('proj-82', 'rebase_conflict')).not.toBe(hostConflictMarker(text));
        expect(git(tree, ['rev-parse', 'HEAD'])).not.toBe(head);
      } finally {
        await app.close();
      }
    });

    it('is handed on by a rebase command with a hostConflict payload', async () => {
      const { app, runs, documents } = await bootDone('proj-85');
      try {
        new CommandHandlers(
          app.get(CommandService),
          {} as never,
          {} as never,
          {} as never,
          {} as never,
          app.get(RunRebaseService),
          { register: jest.fn() } as never,
          {} as never,
          {} as never,
        ).onModuleInit();
        await app.get(CommandService).submit('rebase', 'proj-85', { hostConflict: text });
        expect((await runs.findRun('proj-85'))?.currentStep).toBe('implement');
        expect(await documents.latestBody('proj-85', 'rebase_conflict')).toBe(hostConflictMarker(text));
      } finally {
        await app.close();
      }
    });
  });
});
