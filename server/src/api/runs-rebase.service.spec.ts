import 'reflect-metadata';

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'fs';

import { mkdtemp } from 'fs/promises';

import { tmpdir } from 'os';

import { isAbsolute, join } from 'path';

import { RunRepository } from '../history/run.repository';

import { DocumentRepository } from '../history/document.repository';

import { FlowRepository } from '../history/flow.repository';

import { ARTIFACTS } from '../steps/contract/artifacts';

import { REBASE_CONFLICT } from '../git/rebase';

import { RunRebaseService } from './run-rebase.service';
import { CommandService } from '../pipeline/command.service';
import { writeRunState } from '../history/run-state';
import { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import { FetchFailed } from '../core/swarmloop-error';
import { renderMergeRequest } from '../steps/merge-request/merge-request-record';

import { EnvironmentService } from '../environment/environment.service';

import { httpStatus } from './runs.controller';

import { boot, remember, featureWorktree, denyEnv, git, isAncestor, hostFetch } from '../testing/runs.spec-helpers';

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
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const refresh = jest.spyOn(app.get(EnvironmentService), 'refreshAfterRebase');
      await remember(runs, documents, 'proj-50', 'implement', 'failed');
      const result = await app.get(RunRebaseService).rebase('proj-50');
      expect(result).toEqual({ key: 'proj-50', status: 'started' });
      expect(refresh).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'proj-50' }),
        expect.any(Array),
        new Map([['demo', base]]),
      );
      expect(httpStatus(result)).toBe(202);
      expect(pipeline.startDetached).toHaveBeenCalledWith('proj-50');
      const fresh = await runs.findRun('proj-50');
      expect(fresh?.status).toBe('waiting');
      expect(fresh?.currentStep).toBe('implement');
      expect(await documents.latestBody('proj-50', ARTIFACTS.rebaseMergeSkip.kind)).toBeNull();
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
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const flows = app.get(FlowRepository);
      const run = await remember(runs, documents, 'proj-51', 'done', 'done');
      run.prompt = 'branch: release\n';
      await runs.saveRun(run);
      await documents.putDocument(run, 'implementation', '- changed the field\n');
      const branch = 'feature/proj-51-ship-the-field';
      git(tree, ['push', '-u', 'origin', branch]);
      const tip = git(tree, ['rev-parse', `refs/remotes/origin/${branch}`]);
      const result = await app.get(RunRebaseService).rebase('proj-51');
      expect(result).toEqual({ key: 'proj-51', status: 'started' });
      expect(httpStatus(result)).toBe(202);
      expect(pipeline.startDetached).toHaveBeenCalledWith('proj-51');
      const fresh = await runs.findRun('proj-51');
      expect(fresh?.status).toBe('waiting');
      expect(fresh?.currentStep).toBe('code-review');
      expect((await documents.latestBody('proj-51', ARTIFACTS.rebaseMergeSkip.kind))?.trim()).toBe('skip');
      const rows = await flows.listFlows(fresh?.id ?? 0);
      expect(JSON.parse(rows.at(-1)?.phases ?? '[]')).toEqual(['planning', 'code-review', 'ci']);
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

  it('turns the merge requests of a done run back into drafts before it rebases, and stops when that fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-draft-'));
    const { tree, clone } = featureWorktree(root, 'proj-52');
    writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
    git(tree, ['add', 'src/field.ts']);
    git(tree, ['commit', '-m', 'field']);
    git(clone, ['switch', 'main']);
    writeFileSync(join(clone, 'src', 'base.ts'), 'export const base = 1;\n');
    git(clone, ['add', 'src/base.ts']);
    git(clone, ['commit', '-m', 'base']);
    git(clone, ['push', 'origin', 'main']);
    git(tree, ['push', '-u', 'origin', 'feature/proj-52-ship-the-field']);
    const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-52 started' }) };
    const app = await boot(root, pipeline);
    try {
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await remember(runs, documents, 'proj-52', 'done', 'done');
      await documents.putDocument(run, 'implementation', '- changed the field\n');
      const url = 'https://gitlab.example/group/demo/-/merge_requests/7';
      await documents.putDocument(
        run,
        'merge_request',
        renderMergeRequest([{ project: 'group/demo', iid: 7, url, draft: false, summary: 'Ships it.' }]),
      );
      const setDraft = jest.fn().mockRejectedValueOnce(new FetchFailed('gitlab merge request failed', []));
      Object.assign(app.get(CodeHostRegistry), { byName: () => ({ setDraft }) });
      await expect(app.get(RunRebaseService).rebase('proj-52')).rejects.toThrow('gitlab merge request failed');
      expect(pipeline.startDetached).not.toHaveBeenCalled();
      expect((await runs.findRun('proj-52'))?.status).toBe('done');
      expect(await documents.latestBody('proj-52', 'merge_request')).toContain('draft: false');
      setDraft.mockResolvedValue({ httpCalls: [] });
      await app.get(RunRebaseService).rebase('proj-52');
      expect(setDraft).toHaveBeenLastCalledWith('group/demo', 7, true);
      const body = (await documents.latestBody('proj-52', 'merge_request')) ?? '';
      expect(body).toContain('draft: true');
      expect(body).toContain('Ships it.');
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
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await remember(runs, documents, 'proj-52', 'done', 'done');
      await documents.putDocument(run, 'implementation', '- changed the field\n');
      const result = await app.get(RunRebaseService).rebase('proj-52');
      expect(result).toEqual({ key: 'proj-52', status: 'started' });
      expect(httpStatus(result)).toBe(202);
      const names = git(tree, ['show', '--name-only', '--format=', 'HEAD']);
      expect(names).toContain('src/dirty.ts');
      expect(names).not.toContain('.env');
      expect(git(tree, ['status', '--porcelain'])).toContain('.env');
      git(tree, ['merge-base', '--is-ancestor', base, 'HEAD']);
      expect(git(tree, ['branch', '--show-current'])).toBe('feature/proj-52-ship-the-field');
      expect((await runs.findRun('proj-52'))?.currentStep).toBe('code-review');
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
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      await remember(runs, documents, 'proj-53', 'done', 'done');
      await expect(app.get(RunRebaseService).rebase('proj-53')).rejects.toThrow('demo rebase failed');
      const fresh = await runs.findRun('proj-53');
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
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const flows = app.get(FlowRepository);
      await remember(runs, documents, 'proj-54', 'done', 'done');
      await flows.noteFlow('proj-54', ['code-review', 'ci'], 'code-review');
      await expect(app.get(RunRebaseService).rebase('proj-54')).rejects.toThrow('already in the base');
      expect(pipeline.startDetached).not.toHaveBeenCalled();
      const fresh = await runs.findRun('proj-54');
      expect(fresh?.status).toBe('done');
      expect(fresh?.currentStep).toBe('done');
      expect(await documents.latestBody('proj-54', ARTIFACTS.rebaseMergeSkip.kind)).toBeNull();
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
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await remember(runs, documents, 'proj-55', 'implement-improve', 'failed');
      await documents.putDocument(run, 'implementation', '- changed the field\n');
      await expect(app.get(RunRebaseService).rebase('proj-55')).rejects.toThrow('already in the base');
      expect(pipeline.startDetached).not.toHaveBeenCalled();
      const fresh = await runs.findRun('proj-55');
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
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await remember(runs, documents, 'proj-58', 'implement-improve', 'waiting');
      await documents.putDocument(run, 'implementation', '- changed the field\n');
      await expect(app.get(RunRebaseService).rebase('proj-58')).rejects.toThrow('already in the base');
      expect(pipeline.startDetached).not.toHaveBeenCalled();
      const fresh = await runs.findRun('proj-58');
      expect(fresh?.status).toBe('waiting');
      expect(fresh?.currentStep).toBe('implement-improve');
      expect(await documents.latestBody('proj-58', ARTIFACTS.rebaseMergeSkip.kind)).toBeNull();
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
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await remember(runs, documents, 'proj-56', 'code-review', 'failed');
      await documents.putDocument(run, 'implementation', '- changed the field\n');
      await documents.putDocument(run, 'repos', 'demo\nother\nlater\n');
      const result = await app.get(RunRebaseService).rebase('proj-56');
      expect(result).toEqual({ key: 'proj-56', status: 'started' });
      expect(httpStatus(result)).toBe(202);
      expect(pipeline.startDetached).toHaveBeenCalledWith('proj-56');
      const fresh = await runs.findRun('proj-56');
      expect(fresh?.status).toBe('waiting');
      expect(fresh?.currentStep).toBe('implement');
      expect((await documents.latestBody('proj-56', REBASE_CONFLICT))?.trim()).toBe('pending');
      expect(await documents.latestBody('proj-56', ARTIFACTS.rebaseMergeSkip.kind)).toBeNull();
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
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await remember(runs, documents, 'proj-57', 'done', 'done');
      run.prompt = 'branch: release\n';
      await runs.saveRun(run);
      await documents.putDocument(run, 'implementation', '- changed the field\n');
      const result = await app.get(RunRebaseService).rebase('proj-57');
      expect(result).toEqual({ key: 'proj-57', status: 'started' });
      expect(httpStatus(result)).toBe(202);
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
    writeFileSync(
      join(hooks, 'post-checkout'),
      "#!/bin/sh\nprintf 'export const added = 1;\\n' > src/added.ts\nexit 0\n",
      { mode: 0o755 },
    );
    const pipeline = { startDetached: jest.fn() };
    const app = await boot(root, pipeline);
    try {
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      await remember(runs, documents, 'proj-59', 'done', 'done');
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
      expect(readdirSync(tmpdir()).filter((name) => name.startsWith('swarmloop-rebase-') && !temps.has(name))).toEqual(
        [],
      );
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
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const run = await remember(runs, documents, 'proj-62', 'done', 'done');
      await documents.putDocument(run, 'implementation', '- changed the field\n');
      const result = await app.get(RunRebaseService).rebase('proj-62');
      expect(result).toEqual({ key: 'proj-62', status: 'started' });
      expect(httpStatus(result)).toBe(202);
      const fresh = await runs.findRun('proj-62');
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
      expect(readdirSync(tmpdir()).filter((name) => name.startsWith('swarmloop-rebase-') && !temps.has(name))).toEqual(
        [],
      );
    } finally {
      await app.close();
    }
  });

  describe('a split parent', () => {
    async function splitParent(subtaskStatus: 'running' | 'done') {
      const root = await mkdtemp(join(tmpdir(), 'swarmloop-runs-rebase-split-'));
      const { tree, clone } = featureWorktree(root, 'proj-60');
      writeFileSync(join(tree, 'src', 'field.ts'), 'export const field = 1;\n');
      git(tree, ['add', 'src/field.ts']);
      git(tree, ['commit', '-m', 'field']);
      git(clone, ['switch', 'main']);
      writeFileSync(join(clone, 'src', 'base.ts'), 'export const base = 1;\n');
      git(clone, ['add', 'src/base.ts']);
      git(clone, ['commit', '-m', 'base']);
      git(clone, ['push', 'origin', 'main']);
      const pipeline = { startDetached: jest.fn().mockResolvedValue({ exitCode: 0, message: 'proj-60 started' }) };
      const app = await boot(root, pipeline);
      const runs = app.get(RunRepository);
      const documents = app.get(DocumentRepository);
      const parent = await remember(runs, documents, 'proj-60', 'implement', 'waiting');
      parent.split = true;
      await runs.saveRun(parent);
      await documents.putDocument(
        parent,
        'subtasks',
        `${JSON.stringify([{ id: 'a', title: 'A', status: 'running' }])}\n`,
      );
      const child = await runs.openSubtask('proj-60-a', parent.id, 'a');
      writeRunState(child, { status: subtaskStatus, currentStep: 'implement', ownerPid: process.pid });
      await runs.saveRun(child);
      const records = [{ project: 'demo', iid: 1, url: 'https://code.example/1', draft: false, summary: '' }];
      await documents.putDocument(child, 'repos', 'demo\n');
      await documents.putDocument(child, 'merge_request', renderMergeRequest(records));
      const rebased: string[] = [];
      const commands = app.get(CommandService);
      jest.spyOn(commands, 'accept').mockImplementation((type, key) => {
        if (type === 'rebase') rebased.push(key);
        return Promise.resolve({}) as ReturnType<CommandService['accept']>;
      });
      return { app, runs, rebased };
    }

    it('refuses a rebase while a subtask runs, and leaves the generation as it was', async () => {
      const { app, runs, rebased } = await splitParent('running');
      try {
        const before = (await runs.findRun('proj-60'))?.generation;
        await expect(app.get(RunRebaseService).rebase('proj-60')).rejects.toThrow('SUBTASKS_RUNNING');
        expect((await runs.findRun('proj-60'))?.generation).toBe(before);
        expect(rebased).toEqual([]);
      } finally {
        await app.close();
      }
    });

    it('rebases the feature branch when no subtask runs, and sends every open subtask a Rebase', async () => {
      const { app, runs, rebased } = await splitParent('done');
      try {
        const before = (await runs.findRun('proj-60'))?.generation ?? 0;
        await app.get(RunRebaseService).rebase('proj-60');
        expect((await runs.findRun('proj-60'))?.generation).toBe(before + 1);
        expect(rebased).toEqual(['proj-60-a']);
      } finally {
        await app.close();
      }
    });
  });
});
