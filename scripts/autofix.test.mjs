import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const scripts = ['autofix.sh', 'changed-files.sh', 'lint-changed.sh'];

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function commit(cwd, message) {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message);
}

function writeFile(root, rel, text) {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), text);
}

function changeAndCommit(root, changes) {
  for (const [rel, text] of Object.entries(changes)) {
    writeFile(root, rel, text);
  }
  commit(root, 'change');
}

// Creates a repository holding copies of the scripts and a base commit, then checks out a branch to change files on.
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'autofix-'));
  git(root, 'init', '-q');
  mkdirSync(join(root, 'scripts'));
  for (const script of scripts) {
    copyFileSync(join(scriptsDir, script), join(root, 'scripts', script));
  }
  // The linter itself is covered by check-worktree.test.mjs; here it is a script that finds nothing.
  writeFile(root, 'scripts/lint-added-lines.mjs', '');
  writeFile(root, 'a.ts', 'export const a = 1;\n');
  commit(root, 'base');
  const base = git(root, 'rev-parse', 'HEAD').trim();
  git(root, 'checkout', '-q', '-b', 'feature');
  return { root, base };
}

// Replaces npx with a stub that records its arguments. A prettier call appends a line to REWRITE_FILE,
// then exits 2 when FIXER_FAILS is set.
function stubNpx() {
  const dir = mkdtempSync(join(tmpdir(), 'npx-stub-'));
  const record = join(dir, 'npx-calls.txt');
  writeFileSync(
    join(dir, 'npx'),
    [
      '#!/usr/bin/env bash',
      `printf '%s\\n' "$*" >> "${record}"`,
      'if [[ "$*" == *prettier* && -n "${REWRITE_FILE:-}" ]]; then',
      `  printf 'formatted\\n' >> "$REWRITE_FILE"`,
      'fi',
      'if [[ "$*" == *prettier* && -n "${FIXER_FAILS:-}" ]]; then',
      '  exit 2',
      'fi',
      '',
    ].join('\n'),
  );
  chmodSync(join(dir, 'npx'), 0o755);
  return { path: `${dir}:${process.env.PATH}`, record };
}

function runAutofix(root, base, stub, extraEnv = {}) {
  return spawnSync('bash', [join(root, 'scripts', 'autofix.sh'), base], {
    cwd: root,
    env: { ...process.env, PATH: stub.path, ...extraEnv },
    encoding: 'utf8',
  });
}

test('exits 0 without calling a fixer when no file changed', () => {
  const { root, base } = makeRepo();
  const stub = stubNpx();

  const result = runAutofix(root, base, stub);

  assert.equal(result.status, 0, result.stderr);
  assert.throws(() => readFileSync(stub.record, 'utf8'), { code: 'ENOENT' });
});

test('exits 1 and prints the diff when a fixer changes a changed file', () => {
  const { root, base } = makeRepo();
  changeAndCommit(root, { 'a.ts': 'export const a = 2;\n' });
  const stub = stubNpx();

  const result = runAutofix(root, base, stub, { REWRITE_FILE: 'a.ts' });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /autofix: apply this diff exactly as it is/);
  assert.match(result.stdout, /^\+formatted$/m);
  assert.match(readFileSync(stub.record, 'utf8'), /prettier@3 --write --ignore-unknown a\.ts/);
});

test('exits 0 when the fixers change nothing', () => {
  const { root, base } = makeRepo();
  changeAndCommit(root, { 'a.ts': 'export const a = 2;\n' });
  const stub = stubNpx();

  const result = runAutofix(root, base, stub);

  assert.equal(result.status, 0, result.stderr);
  assert.match(readFileSync(stub.record, 'utf8'), /prettier@3/);
});

test('prints the diff and exits 1 when a fixer fails after changing a file', () => {
  const { root, base } = makeRepo();
  changeAndCommit(root, { 'a.ts': 'export const a = 2;\n' });
  const stub = stubNpx();

  const result = runAutofix(root, base, stub, { REWRITE_FILE: 'a.ts', FIXER_FAILS: '1' });

  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stdout, /^\+formatted$/m);
});

test('exits with the fixer status when a failing fixer changes nothing', () => {
  const { root, base } = makeRepo();
  changeAndCommit(root, { 'a.ts': 'export const a = 2;\n' });
  const stub = stubNpx();

  const result = runAutofix(root, base, stub, { FIXER_FAILS: '1' });

  assert.equal(result.status, 2, result.stderr);
  assert.doesNotMatch(result.stdout, /autofix: apply this diff/);
});
