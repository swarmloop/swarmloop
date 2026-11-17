import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Logger } from '@nestjs/common';
import type { DocumentRepository } from '../history/document.repository';
import type { VisitRepository } from '../history/visit.repository';
import type { RunEntity } from '../history/entities';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { gitOutput } from '../testing/git-fixture';
import { captureTree, parseSnapshot, renderSnapshot, restoreTree, snapshotRun } from '../pipeline/worktree-snapshot';

function git(repo: string, args: string[]): string {
  return gitOutput(repo, ['-C', repo, ...args]);
}

describe('worktree snapshot', () => {
  it('restores the commit and the dirty files without deleting ignored files', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'swarmloop-snapshot-'));
    git(repo, ['init']);
    git(repo, ['config', 'user.email', 'dev@example.com']);
    git(repo, ['config', 'user.name', 'Dev']);
    writeFileSync(join(repo, 'kept'), 'one\n');
    git(repo, ['add', 'kept']);
    git(repo, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'one']);
    const head = git(repo, ['rev-parse', 'HEAD']).trim();
    writeFileSync(join(repo, '.gitignore'), '.env\n');
    writeFileSync(join(repo, '.env'), 'secret\n');
    writeFileSync(join(repo, 'kept'), 'dirty\n');
    writeFileSync(join(repo, 'extra'), 'new\n');

    const captured = await captureTree(repo);
    expect(captured?.head).toBe(head);
    expect(git(repo, ['rev-parse', 'HEAD']).trim()).toBe(head);
    expect(git(repo, ['write-tree']).trim()).toBe(git(repo, ['rev-parse', 'HEAD^{tree}']).trim());

    writeFileSync(join(repo, 'gone'), 'temp\n');
    git(repo, ['add', 'gone']);
    git(repo, ['-c', 'commit.gpgsign=false', 'commit', '-m', 'later']);

    await restoreTree(repo, captured?.head ?? '', captured?.tree ?? '');
    expect(git(repo, ['rev-parse', 'HEAD']).trim()).toBe(head);
    expect(readFileSync(join(repo, 'kept'), 'utf8')).toBe('dirty\n');
    expect(readFileSync(join(repo, 'extra'), 'utf8')).toBe('new\n');
    expect(readFileSync(join(repo, '.env'), 'utf8')).toBe('secret\n');
    expect(() => readFileSync(join(repo, 'gone'), 'utf8')).toThrow();
  });

  it('leaves a directory inside a repository alone', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'swarmloop-nested-'));
    git(repo, ['init']);
    const nested = join(repo, 'nested');
    mkdirSync(nested);
    expect(await captureTree(nested)).toBeNull();
    await expect(restoreTree(nested, '', 'bbb')).rejects.toThrow('snapshot is not the repository root');
  });

  it('logs a snapshot that cannot be saved', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'swarmloop-snapshot-error-'));
    git(repo, ['init']);
    writeFileSync(join(repo, 'kept'), 'one\n');
    const visits = { latestChatId: jest.fn().mockResolvedValue(null) };
    const documents = { putDocument: jest.fn().mockRejectedValue(new Error('boom')) };
    const run = { id: 1, key: 'PROJ-1', targetPath: repo } as unknown as RunEntity;
    const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await snapshotRun(
        {
          documents: documents as unknown as DocumentRepository,
          visits: visits as unknown as VisitRepository,
          root: repo,
        },
        new FakeClock(),
        run,
        'implement',
      );
      expect(error).toHaveBeenCalledWith('boom');
    } finally {
      error.mockRestore();
    }
  });

  describe('snapshotRun', () => {
    function deps(root: string): { put: jest.Mock; deps: Parameters<typeof snapshotRun>[0] } {
      const put = jest.fn().mockResolvedValue(undefined);
      return {
        put,
        deps: {
          documents: { putDocument: put } as unknown as DocumentRepository,
          visits: { latestChatId: jest.fn().mockResolvedValue(null) } as unknown as VisitRepository,
          root,
        },
      };
    }

    it('writes no snapshot and logs the path for a run worktree that is not a repository', async () => {
      const root = mkdtempSync(join(tmpdir(), 'swarmloop-snapshot-root-'));
      const worktree = join(root, 'worktrees', 'PROJ-2', 'api');
      mkdirSync(worktree, { recursive: true });
      const { put, deps: snapshotDeps } = deps(root);
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        await snapshotRun(
          snapshotDeps,
          new FakeClock(),
          { id: 1, key: 'PROJ-2', targetPath: null } as RunEntity,
          'implement',
        );
        expect(put).not.toHaveBeenCalled();
        expect(error).toHaveBeenCalledWith(`api: no git tree at ${worktree}`);
      } finally {
        error.mockRestore();
      }
    });

    it('writes the snapshot of a run worktree that is a repository', async () => {
      const root = mkdtempSync(join(tmpdir(), 'swarmloop-snapshot-root-'));
      const worktree = join(root, 'worktrees', 'PROJ-3', 'api');
      mkdirSync(worktree, { recursive: true });
      git(worktree, ['init']);
      writeFileSync(join(worktree, 'a'), 'a\n');
      const { put, deps: snapshotDeps } = deps(root);

      await snapshotRun(
        snapshotDeps,
        new FakeClock(),
        { id: 1, key: 'PROJ-3', targetPath: null } as RunEntity,
        'implement',
      );

      expect(put).toHaveBeenCalledTimes(1);
    });

    it('writes no snapshot and fails nothing for a checkout that is a subdirectory of a repository', async () => {
      const repo = mkdtempSync(join(tmpdir(), 'swarmloop-snapshot-sub-'));
      git(repo, ['init']);
      mkdirSync(join(repo, 'sub'));
      const { put, deps: snapshotDeps } = deps(repo);
      const error = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
      try {
        const run = { id: 1, key: 'PROJ-4', targetPath: join(repo, 'sub') } as RunEntity;
        await snapshotRun(snapshotDeps, new FakeClock(), run, 'implement');
        expect(put).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
      } finally {
        error.mockRestore();
      }
    });
  });

  it('keeps the step and the time so an unchanged tree is still a new document', () => {
    const first = renderSnapshot({
      step: 'implement',
      at: '2026-10-17T12:00:00.000Z',
      chat: 'chat-1',
      repos: [{ repo: '/tmp/demo', head: 'aaa', tree: 'bbb' }],
    });
    const second = renderSnapshot({
      step: 'implement',
      at: '2026-10-17T12:00:01.000Z',
      chat: 'chat-1',
      repos: [{ repo: '/tmp/demo', head: 'aaa', tree: 'bbb' }],
    });
    expect(first).not.toBe(second);
    expect(parseSnapshot(first)).toMatchObject({
      step: 'implement',
      chat: 'chat-1',
      repos: [{ head: 'aaa', tree: 'bbb' }],
    });
  });
});
