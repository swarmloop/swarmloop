import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'release-tag.mjs');

function run(args, cwd = process.cwd()) {
  const result = spawnSync('node', [script, ...args], { cwd, encoding: 'utf8' });
  return { status: result.status, out: result.stdout.trim(), err: result.stderr.trim() };
}

function git(cwd, ...args) {
  return execFileSync('git', ['-c', 'user.name=ci', '-c', 'user.email=ci@example.com', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();
}

// A repo whose origin/main holds one commit; a second commit exists only on a side branch.
function makeRepo() {
  const cwd = mkdtempSync(join(tmpdir(), 'release-tag-'));
  git(cwd, 'init', '-q', '-b', 'main');
  git(cwd, 'commit', '-q', '--allow-empty', '-m', 'main');
  const onMain = git(cwd, 'rev-parse', 'HEAD');
  git(cwd, 'update-ref', 'refs/remotes/origin/main', onMain);
  git(cwd, 'checkout', '-q', '-b', 'side');
  git(cwd, 'commit', '-q', '--allow-empty', '-m', 'side');
  return { cwd, onMain, off: git(cwd, 'rev-parse', 'HEAD') };
}

test('a good tag prints its version', () => {
  const result = run(['v1.2.3']);
  assert.equal(result.status, 0);
  assert.equal(result.out, '1.2.3');
});

test('a pre-release suffix is accepted', () => {
  assert.equal(run(['v1.2.3-rc.1']).out, '1.2.3-rc.1');
});

test('an internal or malformed tag is rejected before anything else', () => {
  for (const tag of ['refactor/before-phase-2', 'v1.2', '1.2.3', 'v1.2.3-']) {
    const result = run([tag]);
    assert.equal(result.status, 1, tag);
    assert.match(result.err, /not a release tag/);
  }
});

test('a tag on a commit of main is accepted and a moved tag is rejected', () => {
  const { cwd, onMain, off } = makeRepo();

  assert.equal(run(['v1.0.0', onMain], cwd).out, '1.0.0');
  const moved = run(['v1.0.0', off], cwd);
  assert.equal(moved.status, 1);
  assert.match(moved.err, /not on main/);
});

test('classify builds a missing image, reuses the same revision and fails on another', () => {
  assert.equal(run(['classify', '', 'abc']).out, 'build');
  assert.equal(run(['classify', 'abc', 'abc']).out, 'reuse');
  const other = run(['classify', 'old', 'abc']);
  assert.equal(other.status, 1);
  assert.match(other.err, /old.*abc/);
});
