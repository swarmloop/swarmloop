import 'reflect-metadata';
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, symlinkSync, unlinkSync, writeFileSync } from 'fs';
import { mkdtemp } from 'fs/promises';
import { tmpdir } from 'os';
import { isAbsolute, join } from 'path';
import { HistoryService } from '../history/history.service';
import { REBASE_MERGE_SKIP } from '../steps/merge-request/merge-request.service';
import { REBASE_CONFLICT, rebaseFeatureRepos, storedBase } from '../git/rebase-worktree';
import { RunRebaseService } from './run-rebase.service';
import { boot, remember, featureWorktree, denyEnv, git, isAncestor, hostFetch } from './runs.spec-helpers';

describe('runs api', () => {
  it('rebases a failed implement run and continues that checklist', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-failed-'));
    const { tree, clone } = featureWorktree(root, 'proj-50');
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    git(tree, ['add', 'src/field.ts']);
    git(tree, ['commit', '-m', 'field']);
    git(clone, ['switch', 'main']);
    writeFileSync(join(clone, 'src', 'base.ts'), 'export const base = 1;\n');
    git(clone, ['add', 'src/base.ts']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['push', 'origin', 'main']);
    const base = git(clone, ['rev-parse', 'main']);
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-50 started' }) };
    const app = await boot(root, pipeline);
    try {
      const history = app.get(HistoryService);
      await remember(history, 'proj-50', 'implement', 'failed');
      const result = await app.get(RunRebaseService).rebase('proj-50');
      expect(result).toEqual({ http: 202, body: { key: 'proj-50', status: 'started' } });
      expect(pipeline.startDetached).toHaveBeenCalledWith('proj-50');
      const fresh = await history.findRun('proj-50');
      expect(fresh?.status).toBe('waiting');
      expect(fresh?.currentStep).toBe('implement');
      expect(await history.latestBody('proj-50', REBASE_MERGE_SKIP)).toBeNull();
      git(tree, ['merge-base', '--is-ancestor', base, 'HEAD']);
      expect(git(tree, ['branch', '--show-current'])).toBe('feature/proj-50-ship-the-field');
      expect(git(tree, ['log', '--oneline'])).toContain('field');
    } finally {
      await app.close();
    }
  });

  it('rebases a done run and starts code review with ci', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-done-'));
    const { tree, clone } = featureWorktree(root, 'proj-51');
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    git(tree, ['add', 'src/field.ts']);
    git(tree, ['commit', '-m', 'field']);
    git(clone, ['switch', 'main']);
    writeFileSync(join(clone, 'src', 'base.ts'), 'export const base = 1;\n');
    git(clone, ['add', 'src/base.ts']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['branch', 'release']);
    git(clone, ['push', 'origin', 'release']);
    const release = git(clone, ['rev-parse', 'release']);
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-51 started' }) };
    const app = await boot(root, pipeline);
    try {
      const history = app.get(HistoryService);
      const run = await remember(history, 'proj-51', 'done', 'done');
      run.prompt = 'branch: release\n';
      await history.saveRun(run);
      await history.putDocument(run, 'implementation', '- changed the field\n');
      const branch = 'feature/proj-51-ship-the-field';
      git(tree, ['push', '-u', 'origin', branch]);
      const tip = git(tree, ['rev-parse', `refs/remotes/origin/${branch}`]);
      const result = await app.get(RunRebaseService).rebase('proj-51');
      expect(result).toEqual({ http: 202, body: { key: 'proj-51', status: 'started' } });
      expect(pipeline.startDetached).toHaveBeenCalledWith('proj-51');
      const fresh = await history.findRun('proj-51');
      expect(fresh?.status).toBe('waiting');
      expect(fresh?.currentStep).toBe('code-review');
      expect((await history.latestBody('proj-51', REBASE_MERGE_SKIP))?.trim()).toBe('skip');
      const rows = await history.listFlows(fresh?.id ?? 0);
      expect(JSON.parse(rows.at(-1)?.phases ?? '[]')).toEqual(['requirements', 'code-review', 'ci']);
      expect(rows.at(-1)?.fromStep).toBe('code-review');
      git(tree, ['merge-base', '--is-ancestor', release, 'HEAD']);
      expect(git(tree, ['log', '--oneline'])).toContain('field');
      expect(git(tree, ['rev-parse', `refs/remotes/origin/${branch}`])).toBe(tip);
      expect(git(tree, ['rev-parse', 'HEAD'])).not.toBe(tip);
      expect(git(tree, ['branch', '--show-current'])).toBe(branch);
    } finally {
      await app.close();
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
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-52 started' }) };
    const app = await boot(root, pipeline);
    try {
      await denyEnv(app);
      const history = app.get(HistoryService);
      const run = await remember(history, 'proj-52', 'done', 'done');
      await history.putDocument(run, 'implementation', '- changed the field\n');
      const result = await app.get(RunRebaseService).rebase('proj-52');
      expect(result).toEqual({ http: 202, body: { key: 'proj-52', status: 'started' } });
      const names = git(tree, ['show', '--name-only', '--format=', 'HEAD']);
      expect(names).toContain('src/dirty.ts');
      expect(names).not.toContain('.env');
      expect(git(tree, ['status', '--porcelain'])).toContain('.env');
      git(tree, ['merge-base', '--is-ancestor', base, 'HEAD']);
      expect(git(tree, ['branch', '--show-current'])).toBe('feature/proj-52-ship-the-field');
      expect((await history.findRun('proj-52'))?.currentStep).toBe('code-review');
    } finally {
      await app.close();
    }
  });

  it('leaves a done run unchanged when only a denied path is dirty', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-denied-'));
    const { tree } = featureWorktree(root, 'proj-53');
    writeFileSync(join(tree, '.env'), 'TOKEN=1\n');
    git(tree, ['add', '.env']);
    git(tree, ['commit', '-m', 'env']);
    writeFileSync(join(tree, '.env'), 'TOKEN=2\n');
    const head = git(tree, ['rev-parse', 'HEAD']);
    const pipeline = { startDetached: jest.fn() };
    const app = await boot(root, pipeline);
    try {
      await denyEnv(app);
      const history = app.get(HistoryService);
      await remember(history, 'proj-53', 'done', 'done');
      await expect(app.get(RunRebaseService).rebase('proj-53')).rejects.toThrow('demo rebase failed');
      const fresh = await history.findRun('proj-53');
      expect(fresh?.status).toBe('done');
      expect(fresh?.currentStep).toBe('done');
      expect(git(tree, ['rev-parse', 'HEAD'])).toBe(head);
      expect(git(tree, ['status', '--porcelain'])).toContain('.env');
      expect(pipeline.startDetached).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it('sends a done run with no implementation notes to implement', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-unfinished-'));
    const { tree } = featureWorktree(root, 'proj-54');
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-54 started' }) };
    const app = await boot(root, pipeline);
    try {
      const history = app.get(HistoryService);
      await remember(history, 'proj-54', 'done', 'done');
      await history.noteFlow('proj-54', ['code-review', 'ci'], 'code-review');
      await expect(app.get(RunRebaseService).rebase('proj-54')).rejects.toThrow('already in the base');
      expect(pipeline.startDetached).not.toHaveBeenCalled();
      const fresh = await history.findRun('proj-54');
      expect(fresh?.status).toBe('done');
      expect(fresh?.currentStep).toBe('done');
      expect(await history.latestBody('proj-54', REBASE_MERGE_SKIP)).toBeNull();
      expect(git(tree, ['branch', '--show-current'])).toBe('feature/proj-54-ship-the-field');
    } finally {
      await app.close();
    }
  });

  it('resumes a finished failed run on its step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-resume-'));
    const { tree } = featureWorktree(root, 'proj-55');
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-55 started' }) };
    const app = await boot(root, pipeline);
    try {
      const history = app.get(HistoryService);
      const run = await remember(history, 'proj-55', 'implement-improve', 'failed');
      await history.putDocument(run, 'implementation', '- changed the field\n');
      await expect(app.get(RunRebaseService).rebase('proj-55')).rejects.toThrow('already in the base');
      expect(pipeline.startDetached).not.toHaveBeenCalled();
      const fresh = await history.findRun('proj-55');
      expect(fresh?.status).toBe('failed');
      expect(fresh?.currentStep).toBe('implement-improve');
      expect(git(tree, ['branch', '--show-current'])).toBe('feature/proj-55-ship-the-field');
    } finally {
      await app.close();
    }
  });

  it('rebases a waiting run and resumes that step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-waiting-'));
    const { tree } = featureWorktree(root, 'proj-58');
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-58 started' }) };
    const app = await boot(root, pipeline);
    try {
      const history = app.get(HistoryService);
      const run = await remember(history, 'proj-58', 'implement-improve', 'waiting');
      await history.putDocument(run, 'implementation', '- changed the field\n');
      await expect(app.get(RunRebaseService).rebase('proj-58')).rejects.toThrow('already in the base');
      expect(pipeline.startDetached).not.toHaveBeenCalled();
      const fresh = await history.findRun('proj-58');
      expect(fresh?.status).toBe('waiting');
      expect(fresh?.currentStep).toBe('implement-improve');
      expect(await history.latestBody('proj-58', REBASE_MERGE_SKIP)).toBeNull();
      expect(git(tree, ['branch', '--show-current'])).toBe('feature/proj-58-ship-the-field');
    } finally {
      await app.close();
    }
  });

  it('leaves a conflict in progress and does not skip the merge request', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-conflict-'));
    const { tree: demo, clone: demoClone } = featureWorktree(root, 'proj-56', 'demo');
    const { tree: other, clone: otherClone } = featureWorktree(root, 'proj-56', 'other');
    const { tree: later, clone: laterClone } = featureWorktree(root, 'proj-56', 'later');
    writeFileSync(join(demo, 'src', 'field.ts'), 'export const field = 1;\n');
    git(demo, ['add', 'src/field.ts']);
    git(demo, ['commit', '-m', 'field']);
    git(demoClone, ['switch', 'main']);
    writeFileSync(join(demoClone, 'src', 'base.ts'), 'export const base = 1;\n');
    git(demoClone, ['add', 'src/base.ts']);
    git(demoClone, ['commit', '-m', 'base']);
    git(demoClone, ['push', 'origin', 'main']);
    const demoBase = git(demoClone, ['rev-parse', 'main']);
    writeFileSync(join(other, 'src', 'field.ts'), 'export const field = 1;\n');
    git(other, ['add', 'src/field.ts']);
    git(other, ['commit', '-m', 'field']);
    git(otherClone, ['switch', 'main']);
    writeFileSync(join(otherClone, 'src', 'field.ts'), 'export const field = 2;\n');
    git(otherClone, ['add', 'src/field.ts']);
    git(otherClone, ['commit', '-m', 'base']);
    git(otherClone, ['push', 'origin', 'main']);
    writeFileSync(join(later, 'src', 'keep.ts'), 'export const keep = 1;\n');
    git(later, ['add', 'src/keep.ts']);
    git(later, ['commit', '-m', 'keep']);
    git(laterClone, ['switch', 'main']);
    writeFileSync(join(laterClone, 'src', 'next.ts'), 'export const next = 1;\n');
    git(laterClone, ['add', 'src/next.ts']);
    git(laterClone, ['commit', '-m', 'next']);
    git(laterClone, ['push', 'origin', 'main']);
    const laterBase = git(laterClone, ['rev-parse', 'main']);
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-56 started' }) };
    const app = await boot(root, pipeline);
    try {
      const history = app.get(HistoryService);
      const run = await remember(history, 'proj-56', 'code-review', 'failed');
      await history.putDocument(run, 'implementation', '- changed the field\n');
      await history.putDocument(run, 'repos', 'demo\nother\nlater\n');
      const result = await app.get(RunRebaseService).rebase('proj-56');
      expect(result).toEqual({ http: 202, body: { key: 'proj-56', status: 'started' } });
      expect(pipeline.startDetached).toHaveBeenCalledWith('proj-56');
      const fresh = await history.findRun('proj-56');
      expect(fresh?.status).toBe('waiting');
      expect(fresh?.currentStep).toBe('implement');
      expect((await history.latestBody('proj-56', REBASE_CONFLICT))?.trim()).toBe('pending');
      expect(await history.latestBody('proj-56', REBASE_MERGE_SKIP)).toBeNull();
      expect(isAncestor(demo, demoBase)).toBe(true);
      expect(git(demo, ['branch', '--show-current'])).toBe('feature/proj-56-ship-the-field');
      expect(git(other, ['diff', '--name-only', '--diff-filter=U'])).toContain('src/field.ts');
      expect(git(other, ['branch', '--show-current'])).toBe('feature/proj-56-ship-the-field');
      expect(isAncestor(later, laterBase)).toBe(false);
      expect(git(later, ['branch', '--show-current'])).toBe('feature/proj-56-ship-the-field');
    } finally {
      await app.close();
    }
  });

  it('rebases onto the fetched remote source when the local tracking ref is stale', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-remote-'));
    const { tree, clone } = featureWorktree(root, 'proj-57');
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    git(tree, ['add', 'src/field.ts']);
    git(tree, ['commit', '-m', 'field']);
    git(clone, ['switch', 'main']);
    git(clone, ['switch', '-c', 'release']);
    writeFileSync(join(clone, 'src', 'base.ts'), 'export const base = 1;\n');
    git(clone, ['add', 'src/base.ts']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['push', 'origin', 'release']);
    const stale = git(tree, ['rev-parse', 'origin/release']);
    const bare = join(root, 'demo.git');
    const other = join(root, 'other');
    git(root, ['clone', bare, other]);
    git(other, ['config', 'user.email', 'dev@example.com']);
    git(other, ['config', 'user.name', 'Dev']);
    git(other, ['switch', '--track', 'origin/release']);
    writeFileSync(join(other, 'src', 'remote.ts'), 'export const remote = 1;\n');
    git(other, ['add', 'src/remote.ts']);
    git(other, ['commit', '-m', 'remote']);
    git(other, ['push', 'origin', 'HEAD:release']);
    const tip = git(bare, ['rev-parse', 'refs/heads/release']);
    expect(tip).not.toBe(stale);
    expect(git(tree, ['rev-parse', 'origin/release'])).toBe(stale);
    git(tree, ['remote', 'set-url', 'origin', 'git@gitlab.example:group/demo.git']);
    const restore = hostFetch(bare, 'token');
    const previousSsh = process.env.GIT_SSH_COMMAND;
    process.env.GIT_SSH_COMMAND = 'false';
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-57 started' }) };
    const app = await boot(root, pipeline);
    try {
      const history = app.get(HistoryService);
      const run = await remember(history, 'proj-57', 'done', 'done');
      run.prompt = 'branch: release\n';
      await history.saveRun(run);
      await history.putDocument(run, 'implementation', '- changed the field\n');
      const result = await app.get(RunRebaseService).rebase('proj-57');
      expect(result).toEqual({ http: 202, body: { key: 'proj-57', status: 'started' } });
      expect(git(tree, ['rev-parse', 'origin/release'])).toBe(tip);
      expect(isAncestor(tree, tip)).toBe(true);
      expect(git(tree, ['log', '--oneline'])).toContain('field');
    } finally {
      if (previousSsh === undefined) {
        delete process.env.GIT_SSH_COMMAND;
      } else {
        process.env.GIT_SSH_COMMAND = previousSsh;
      }
      restore();
      await app.close();
    }
  });

  it('aborts a rebase that stops with nothing applied', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-untracked-'));
    const { tree, clone } = featureWorktree(root, 'proj-59');
    writeFileSync(join(tree, 'src', 'added.ts'), 'export const added = 1;\n');
    git(tree, ['add', 'src/added.ts']);
    git(tree, ['commit', '-m', 'add file']);
    git(tree, ['rm', 'src/added.ts']);
    git(tree, ['commit', '-m', 'drop file']);
    git(clone, ['switch', 'main']);
    writeFileSync(join(clone, 'src', 'base.ts'), 'export const base = 1;\n');
    git(clone, ['add', 'src/base.ts']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['push', 'origin', 'main']);
    const base = git(clone, ['rev-parse', 'main']);
    writeFileSync(join(tree, 'src', 'readme.ts'), 'export const readme = 2;\n');
    git(tree, ['add', 'src/readme.ts']);
    const savedTree = git(tree, ['write-tree']);
    const saved = git(tree, ['commit-tree', savedTree, '-m', 'swarmloop-rebase\nsrc/readme.ts']);
    git(tree, ['update-ref', 'refs/worktree/swarmloop-rebase', saved]);
    git(tree, ['reset', '-q', 'HEAD', '--', 'src/readme.ts']);
    git(tree, ['checkout', 'HEAD', '--', 'src/readme.ts']);
    expect(git(tree, ['status', '--porcelain'])).toBe('');
    const head = git(tree, ['rev-parse', 'HEAD']);
    const common = git(tree, ['rev-parse', '--git-common-dir']);
    const hooks = join(isAbsolute(common) ? common : join(tree, common), 'hooks');
    mkdirSync(hooks, { recursive: true });
    writeFileSync(join(hooks, 'post-checkout'), "#!/bin/sh\nprintf 'export const added = 1;\\n' > src/added.ts\nexit 0\n", { mode: 0o755 });
    const pipeline = { startDetached: jest.fn() };
    const app = await boot(root, pipeline);
    try {
      const history = app.get(HistoryService);
      await remember(history, 'proj-59', 'done', 'done');
      const temps = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith('swarmloop-rebase-')));
      await expect(app.get(RunRebaseService).rebase('proj-59')).rejects.toThrow(/demo rebase failed: empty squash/);
      expect(pipeline.startDetached).not.toHaveBeenCalled();
      expect(git(tree, ['rev-parse', 'HEAD'])).toBe(head);
      expect(git(tree, ['branch', '--show-current'])).toBe('feature/proj-59-ship-the-field');
      expect(isAncestor(tree, base)).toBe(false);
      for (const name of ['rebase-merge', 'rebase-apply']) {
        const printed = git(tree, ['rev-parse', '--git-path', name]);
        expect(existsSync(isAbsolute(printed) ? printed : join(tree, printed))).toBe(false);
      }
      expect(readFileSync(join(tree, 'src', 'readme.ts'), 'utf8')).toBe('export const readme = 2;\n');
      expect(readdirSync(tmpdir()).filter((name) => name.startsWith('swarmloop-rebase-') && !temps.has(name))).toEqual([]);
    } finally {
      await app.close();
    }
  });

  it('squashes three commits onto the new base as one', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-squash-'));
    const { tree, clone } = featureWorktree(root, 'proj-62');
    for (const name of ['one', 'two', 'three']) {
      writeFileSync(join(tree, 'src', `${name}.ts`), `export const ${name} = 1;\n`);
      git(tree, ['add', `src/${name}.ts`]);
      git(tree, ['commit', '-m', name]);
    }
    git(clone, ['switch', 'main']);
    writeFileSync(join(clone, 'src', 'base.ts'), 'export const base = 1;\n');
    git(clone, ['add', 'src/base.ts']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['push', 'origin', 'main']);
    const base = git(clone, ['rev-parse', 'main']);
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-62 started' }) };
    const app = await boot(root, pipeline);
    const temps = new Set(readdirSync(tmpdir()).filter((name) => name.startsWith('swarmloop-rebase-')));
    try {
      const history = app.get(HistoryService);
      const run = await remember(history, 'proj-62', 'done', 'done');
      await history.putDocument(run, 'implementation', '- changed the field\n');
      const result = await app.get(RunRebaseService).rebase('proj-62');
      expect(result).toEqual({ http: 202, body: { key: 'proj-62', status: 'started' } });
      const fresh = await history.findRun('proj-62');
      expect(fresh?.status).toBe('waiting');
      expect(fresh?.currentStep).toBe('code-review');
      expect(git(tree, ['rev-parse', 'HEAD^'])).toBe(base);
      expect(git(tree, ['rev-list', '--count', `${base}..HEAD`])).toBe('1');
      expect(git(tree, ['log', '-1', '--format=%s'])).toBe('feat(proj-62): Ship the field');
      expect(git(tree, ['branch', '--show-current'])).toBe('feature/proj-62-ship-the-field');
      const names = git(tree, ['show', '--name-only', '--format=', 'HEAD']);
      expect(names).toContain('src/one.ts');
      expect(names).toContain('src/two.ts');
      expect(names).toContain('src/three.ts');
      expect(readdirSync(tmpdir()).filter((name) => name.startsWith('swarmloop-rebase-') && !temps.has(name))).toEqual([]);
    } finally {
      await app.close();
    }
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
      hosts: { GITLAB_BASE_URL: '', GITLAB_TOKEN: '', GITHUB_BASE_URL: '', GITHUB_TOKEN: '' },
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
      expect(readdirSync(tmpdir()).filter((name) => name.startsWith('swarmloop-rebase-') && !temps.has(name))).toEqual([]);
      writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 3;\n');
      const next = await rebaseFeatureRepos(input);
      expect(next).toEqual({ kind: 'clean', leases: [{ repo: 'demo', tip: remoteTip }] });
      expect(git(tree, ['rev-parse', 'HEAD^'])).toBe(base);
      expect(git(tree, ['rev-list', '--count', `${base}..HEAD`])).toBe('1');
      expect(git(tree, ['log', '-1', '--format=%s'])).toBe('feat(proj-64): Ship the field');
      expect(readFileSync(join(tree, 'src', 'field.ts'), 'utf8')).toBe('export const field = 3;\n');
      expect(git(tree, ['rev-parse', `refs/remotes/origin/${branch}`])).toBe(remoteTip);
      expect(readdirSync(tmpdir()).filter((name) => name.startsWith('swarmloop-rebase-') && !temps.has(name))).toEqual([]);
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
      const history = app.get(HistoryService);
      const run = await remember(history, 'proj-63', 'done', 'done');
      await history.putDocument(run, 'implementation', '- changed the field\n');
      const result = await app.get(RunRebaseService).rebase('proj-63');
      expect(result).toEqual({ http: 202, body: { key: 'proj-63', status: 'started' } });
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
      const history = app.get(HistoryService);
      const run = await remember(history, 'proj-66', 'done', 'done');
      await history.putDocument(run, 'implementation', '- changed the field\n');
      const result = await app.get(RunRebaseService).rebase('proj-66');
      expect(result).toEqual({ http: 202, body: { key: 'proj-66', status: 'started' } });
      expect(pipeline.startDetached).toHaveBeenCalledWith('proj-66');
      const fresh = await history.findRun('proj-66');
      expect(fresh?.status).toBe('waiting');
      expect(fresh?.currentStep).toBe('implement');
      expect((await history.latestBody('proj-66', REBASE_CONFLICT))?.trim()).toBe('pending');
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
      hosts: { GITLAB_BASE_URL: '', GITLAB_TOKEN: '', GITHUB_BASE_URL: '', GITHUB_TOKEN: '' },
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
      expect(readFileSync(join(tree, 'src', 'parts.ts'), 'utf8')).toBe('export const a = 2;\nexport const mid = 1;\nexport const b = 2;\n');
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
      expect(readdirSync(tmpdir()).filter((name) => name.startsWith('swarmloop-rebase-') && !temps.has(name))).toEqual([]);
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
    const hosts = { GITLAB_BASE_URL: '', GITLAB_TOKEN: '', GITHUB_BASE_URL: '', GITHUB_TOKEN: '' };
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
    git(root, ['clone', join(root, 'demo.git'), other]);
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
    const hosts = { GITLAB_BASE_URL: '', GITLAB_TOKEN: '', GITHUB_BASE_URL: '', GITHUB_TOKEN: '' };
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
    const hosts = { GITLAB_BASE_URL: '', GITLAB_TOKEN: '', GITHUB_BASE_URL: '', GITHUB_TOKEN: '' };
    const input = (key: string) => ({
      root,
      key,
      repos: ['demo'],
      branch: `feature/${key}-ship-the-field`,
      prompt: null,
      denied: ['.env'],
      message: `feat(${key}): Ship the field`,
      hosts,
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
        hosts: { GITLAB_BASE_URL: '', GITLAB_TOKEN: '', GITHUB_BASE_URL: '', GITHUB_TOKEN: '' },
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
        hosts: { GITLAB_BASE_URL: '', GITLAB_TOKEN: '', GITHUB_BASE_URL: '', GITHUB_TOKEN: '' },
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
        hosts: { GITLAB_BASE_URL: '', GITLAB_TOKEN: '', GITHUB_BASE_URL: '', GITHUB_TOKEN: '' },
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
});
