import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { changedFiles } from './check-worktree.mjs';
import { lintAddedLines } from './lint-added-lines.mjs';

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

// A repository whose strict config warns on `var` and errors on `debugger`, with a committed base holding an old warning.
function lintFixture() {
  const root = mkdtempSync(join(tmpdir(), 'swarmloop-lint-added-'));
  const git = (...args) =>
    execFileSync('git', ['-C', root, '-c', 'user.name=t', '-c', 'user.email=t@localhost', ...args]);
  git('init', '-q');
  writeFileSync(
    join(root, 'eslint.strict.config.mjs'),
    "export default [{ files: ['**/*.ts'], rules: { 'no-var': 'warn', 'no-debugger': 'error' } }];\n",
  );
  writeFileSync(join(root, 'old.ts'), 'var old = 1;\nconst keep = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'base');
  const base = execFileSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  return { root, base, git };
}

async function lintMessages(fixture, files) {
  const { kept } = await lintAddedLines({ root: fixture.root, base: fixture.base, files });
  return kept.flatMap((result) =>
    result.messages.map((message) => `${result.filePath.split('/').pop()}:${message.line}`),
  );
}

test('passes an old warning on a line the change did not touch', async () => {
  const fixture = lintFixture();
  try {
    writeFileSync(join(fixture.root, 'old.ts'), 'var old = 1;\nconst keep = 2;\n');
    assert.deepEqual(await lintMessages(fixture, ['old.ts']), []);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('fails a new warning on an added line', async () => {
  const fixture = lintFixture();
  try {
    writeFileSync(join(fixture.root, 'old.ts'), 'var old = 1;\nconst keep = 1;\nvar added = 1;\n');
    assert.deepEqual(await lintMessages(fixture, ['old.ts']), ['old.ts:3']);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('fails an error on an untouched line of a changed file', async () => {
  const fixture = lintFixture();
  try {
    writeFileSync(join(fixture.root, 'old.ts'), 'var old = 1;\ndebugger;\n');
    fixture.git('commit', '-qam', 'old error');
    fixture.base = execFileSync('git', ['-C', fixture.root, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    writeFileSync(join(fixture.root, 'old.ts'), 'var old = 1;\ndebugger;\nconst more = 1;\n');
    assert.deepEqual(await lintMessages(fixture, ['old.ts']), ['old.ts:2']);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('fails a warning in a new untracked file', async () => {
  const fixture = lintFixture();
  try {
    writeFileSync(join(fixture.root, 'new.ts'), 'var fresh = 1;\n');
    assert.deepEqual(await lintMessages(fixture, ['new.ts']), ['new.ts:1']);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});
