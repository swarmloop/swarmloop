import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { measure } from './measure-step-open.mjs';

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  });
}

test('both snapshots give the same tree and the fetch is timed', () => {
  const root = mkdtempSync(join(tmpdir(), 'measure-open-'));
  const remote = join(root, 'remote.git');
  const work = join(root, 'work');
  git(root, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'clone', '-q', remote, work);
  writeFileSync(join(work, 'a.txt'), 'a\n');
  git(work, 'add', '-A');
  git(work, 'commit', '-q', '-m', 'base');
  git(work, 'push', '-q', 'origin', 'HEAD:main');
  writeFileSync(join(work, 'b.txt'), 'untracked\n');
  const result = measure(work, 'main');
  assert.equal(result.sameTree, true);
  assert.match(result.tree, /^[0-9a-f]{40}$/);
  assert.equal(typeof result.snapshotBeforeMs, 'number');
  assert.equal(typeof result.snapshotAfterMs, 'number');
  assert.equal(typeof result.fetchMs, 'number');
});
