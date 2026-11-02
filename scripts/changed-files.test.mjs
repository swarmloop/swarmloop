import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const script = join(dirname(fileURLToPath(import.meta.url)), 'changed-files.sh');

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function commit(cwd, message) {
  git(cwd, 'add', '-A');
  git(cwd, '-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-q', '-m', message);
}

// Creates a repository with a base commit, then checks out a branch to change files on.
function makeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'changed-files-'));
  git(root, 'init', '-q');
  writeFile(root, 'a.ts', 'export const a = 1;\n');
  writeFile(root, 'b.ts', 'export const b = 1;\n');
  writeFile(root, 'notes.md', 'notes\n');
  commit(root, 'base');
  const base = git(root, 'rev-parse', 'HEAD').trim();
  git(root, 'checkout', '-q', '-b', 'feature');
  return { root, base };
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

function changedFiles(root, base, ...exts) {
  return execFileSync('bash', [script, base, ...exts], { cwd: root, encoding: 'utf8' });
}

test('lists a changed file', () => {
  const { root, base } = makeRepo();
  changeAndCommit(root, { 'a.ts': 'export const a = 2;\n' });

  assert.equal(changedFiles(root, base, 'ts'), 'a.ts\n');
});

test('does not list an unchanged file', () => {
  const { root, base } = makeRepo();
  changeAndCommit(root, { 'a.ts': 'export const a = 2;\n' });

  assert.doesNotMatch(changedFiles(root, base, 'ts'), /b\.ts/);
});

test('applies the extension filter', () => {
  const { root, base } = makeRepo();
  changeAndCommit(root, { 'a.ts': 'export const a = 2;\n', 'notes.md': 'changed\n' });

  assert.equal(changedFiles(root, base, 'md'), 'notes.md\n');
});

test('prints nothing when no file changed', () => {
  const { root, base } = makeRepo();

  assert.equal(changedFiles(root, base, 'ts', 'tsx'), '');
});
