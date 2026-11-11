import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { captureTree } from './worktree-tree';

function git(repo: string, args: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', env: { ...process.env, ...env } }).trim();
}

/** The tree git makes with an empty index: every file is hashed again. */
function emptyIndexTree(repo: string): string {
  const index = join(mkdtempSync(join(tmpdir(), 'swarmloop-empty-index-')), 'index');
  git(repo, ['add', '-A'], { GIT_INDEX_FILE: index });
  return git(repo, ['write-tree'], { GIT_INDEX_FILE: index });
}

function bigRepo(files: number): string {
  const repo = mkdtempSync(join(tmpdir(), 'swarmloop-big-'));
  git(repo, ['init', '-q']);
  git(repo, ['config', 'user.email', 'dev@example.com']);
  git(repo, ['config', 'user.name', 'Dev']);
  for (let directory = 0; directory < files / 100; directory += 1) {
    mkdirSync(join(repo, `d${directory}`));
    for (let file = 0; file < 100; file += 1) {
      writeFileSync(join(repo, `d${directory}`, `f${file}.txt`), `${directory}-${file}\n`);
    }
  }
  git(repo, ['add', '-A']);
  git(repo, ['-c', 'commit.gpgsign=false', 'commit', '-q', '-m', 'base']);
  return repo;
}

describe('captureTree', () => {
  it('gives the tree of an empty index, with 20 000 tracked files and one changed', async () => {
    const repo = bigRepo(20_000);
    writeFileSync(join(repo, 'd0', 'f0.txt'), 'changed\n');
    writeFileSync(join(repo, 'untracked.txt'), 'new\n');

    const captured = await captureTree(repo);

    expect(captured?.tree).toBe(emptyIndexTree(repo));
    expect(captured?.head).toBe(git(repo, ['rev-parse', 'HEAD']));
    rmSync(repo, { recursive: true, force: true });
  }, 120_000);

  it('hashes only the files that changed: a file git still sees as unchanged keeps its stored content', async () => {
    const repo = bigRepo(200);
    const file = join(repo, 'd1', 'f1.txt');
    // An mtime older than the index, so git does not treat the file as racily clean.
    const past = new Date(Date.now() - 3_600_000);
    utimesSync(file, past, past);
    git(repo, ['update-index', '-q', '--refresh']);
    const before = statSync(file);
    // Same size and mtime, other bytes. Git trusts the stat of its own index, so it does not read this file again.
    writeFileSync(file, `${'x'.repeat(before.size - 1)}\n`);
    utimesSync(file, before.atime, before.mtime);
    writeFileSync(join(repo, 'd0', 'f0.txt'), 'changed\n');

    const captured = await captureTree(repo);

    const stored = git(repo, ['rev-parse', 'HEAD:d1/f1.txt']);
    expect(git(repo, ['rev-parse', `${captured?.tree}:d1/f1.txt`])).toBe(stored);
    expect(git(repo, ['cat-file', '-p', `${captured?.tree}:d0/f0.txt`])).toBe('changed');
    rmSync(repo, { recursive: true, force: true });
  });

  it('leaves the index and HEAD of the repository alone', async () => {
    const repo = bigRepo(100);
    writeFileSync(join(repo, 'new.txt'), 'new\n');
    const status = git(repo, ['status', '--porcelain']);
    const head = git(repo, ['rev-parse', 'HEAD']);

    await captureTree(repo);

    expect(git(repo, ['status', '--porcelain'])).toBe(status);
    expect(git(repo, ['rev-parse', 'HEAD'])).toBe(head);
    rmSync(repo, { recursive: true, force: true });
  });

  it('works in a repository with no index file yet', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'swarmloop-fresh-'));
    git(repo, ['init', '-q']);
    writeFileSync(join(repo, 'a.txt'), 'a\n');

    const captured = await captureTree(repo);

    expect(captured?.tree).toBe(emptyIndexTree(repo));
    rmSync(repo, { recursive: true, force: true });
  });
});
