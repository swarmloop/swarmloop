import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { makeRepo, runGit, writeFiles } from './git-repo.spec-helpers';
import { ignoredDirectories, isCheckout, trackedFiles } from './ignored-entries';

describe('ignored entries', () => {
  it('lists ignored directories, top-level and nested, and not ignored files', async () => {
    const repo = makeRepo({ '.gitignore': '.venv/\n.env\n' });
    writeFiles(repo, { '.venv/a': 'x', 'apps/.venv/b': 'x', 'apps/.env': 'x', '.env': 'x', 'src/a.txt': 'x' });
    expect([...(await ignoredDirectories(repo))].sort()).toEqual(['.venv', 'apps/.venv']);
  });

  it('lists a directory that ignores itself with a `*` gitignore', async () => {
    const repo = makeRepo();
    writeFiles(repo, { 'env/.gitignore': '*\n', 'env/a': 'x' });
    expect([...(await ignoredDirectories(repo))]).toEqual(['env']);
  });

  it('does not list an ignored directory that holds a tracked file', async () => {
    const repo = makeRepo({ 'dist/keep.txt': 'x' });
    writeFiles(repo, { '.gitignore': 'dist/\n', 'dist/other.txt': 'x' });
    expect([...(await ignoredDirectories(repo))]).toEqual([]);
  });

  it('lists nothing when a directory holds only ignored files but no rule names it', async () => {
    const repo = makeRepo({ '.gitignore': '*.log\n' });
    writeFiles(repo, { 'logs/a.log': 'x' });
    expect([...(await ignoredDirectories(repo))]).toEqual([]);
  });

  it('lists tracked files only', async () => {
    const repo = makeRepo({ 'a.txt': 'x' });
    writeFiles(repo, { 'b.txt': 'x' });
    expect([...(await trackedFiles(repo))].sort()).toEqual(['a.txt']);
  });

  it('knows a repository and a worktree from a plain directory', async () => {
    const repo = makeRepo();
    const tree = join(mkdtempSync(join(tmpdir(), 'swarmloop-tree-')), 'wt');
    runGit(repo, ['worktree', 'add', '-q', '-b', 'side', tree]);
    expect([isCheckout(repo), isCheckout(tree), isCheckout(mkdtempSync(join(tmpdir(), 'plain-')))]).toEqual([
      true,
      true,
      false,
    ]);
  });
});
