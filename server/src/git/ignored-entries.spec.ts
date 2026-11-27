import { makeRepo, writeFiles } from './git-repo.spec-helpers';
import { ignoredDirectories } from './ignored-entries';

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
});
