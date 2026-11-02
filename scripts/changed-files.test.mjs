import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const changedFilesScript = join(scriptsDir, 'changed-files.sh');
const lintChangedScript = join(scriptsDir, 'lint-changed.sh');

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function writeFiles(root, files) {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
}

function commitAll(root, message) {
  git(root, ['add', '.']);
  git(root, ['commit', '-q', '-m', message]);
}

// Creates a repo with `base` committed on main, then checks out a feature branch.
function makeRepo(base) {
  const root = mkdtempSync(join(tmpdir(), 'changed-files-'));
  git(root, ['init', '-q', '-b', 'main']);
  git(root, ['config', 'user.name', 'Test User']);
  git(root, ['config', 'user.email', 'test@example.com']);
  writeFiles(root, base);
  commitAll(root, 'base');
  git(root, ['checkout', '-q', '-b', 'feature']);
  return root;
}

function changedFiles(root, globs) {
  const output = execFileSync('bash', [changedFilesScript, 'main', ...globs], { cwd: root, encoding: 'utf8' });
  return output.split('\n').filter(Boolean);
}

test('lists changed and added files and skips deleted ones', () => {
  const root = makeRepo({ 'a.ts': 'export const a = 1;\n', 'b.ts': 'export const b = 1;\n' });
  writeFiles(root, { 'a.ts': 'export const a = 2;\n', 'c.ts': 'export const c = 1;\n' });
  rmSync(join(root, 'b.ts'));
  commitAll(root, 'change');

  assert.deepEqual(changedFiles(root, []), ['a.ts', 'c.ts']);
});

test('keeps only the files that match a glob', () => {
  const root = makeRepo({ 'server/a.ts': 'export {};\n', 'docs/readme.md': 'old\n' });
  writeFiles(root, { 'server/a.ts': 'export const a = 1;\n', 'docs/readme.md': 'new\n' });
  commitAll(root, 'change');

  assert.deepEqual(changedFiles(root, ['*.ts']), ['server/a.ts']);
});

test('lint-changed exits 0 without running ESLint when no TypeScript file changed', () => {
  const root = makeRepo({ 'README.md': 'old\n' });
  writeFiles(root, { 'README.md': 'new\n' });
  commitAll(root, 'change');

  // A fake npx that fails, so any ESLint call would fail the test.
  const bin = mkdtempSync(join(tmpdir(), 'fake-bin-'));
  writeFileSync(join(bin, 'npx'), '#!/bin/sh\necho "npx was called" >&2\nexit 1\n', { mode: 0o755 });
  const result = spawnSync('bash', [lintChangedScript, 'main'], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});
