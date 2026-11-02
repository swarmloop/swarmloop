import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { captureTree, parseSnapshot, renderSnapshot, restoreTree } from './worktree-snapshot';

function git(repo: string, args: string[]): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' });
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
    expect(parseSnapshot(first)).toMatchObject({ step: 'implement', chat: 'chat-1', repos: [{ head: 'aaa', tree: 'bbb' }] });
  });
});
