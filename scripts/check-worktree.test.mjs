import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { changedFiles } from './check-worktree.mjs';

test('selects modified and new files with spaces, excluding deleted and ignored files', () => {
  const root = mkdtempSync(join(tmpdir(), 'swarmloop-worktree-check-'));
  const git = (...args) =>
    execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args]);
  try {
    git('init', '-q');
    writeFileSync(join(root, 'existing.ts'), 'before\n');
    writeFileSync(join(root, 'deleted.ts'), 'before\n');
    writeFileSync(join(root, '.gitignore'), 'ignored.ts\n');
    git('add', '.');
    git('commit', '-qm', 'fixture');
    git('update-ref', 'refs/remotes/origin/main', 'HEAD');
    writeFileSync(join(root, 'committed.ts'), 'feature\n');
    git('add', 'committed.ts');
    git('commit', '-qm', 'feature');
    writeFileSync(join(root, 'existing.ts'), 'after\n');
    writeFileSync(join(root, 'new file.ts'), 'new\n');
    writeFileSync(join(root, 'ignored.ts'), 'ignore\n');
    rmSync(join(root, 'deleted.ts'));
    assert.deepEqual(changedFiles(root).sort(), ['committed.ts', 'existing.ts', 'new file.ts']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
