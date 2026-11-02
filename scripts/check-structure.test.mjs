import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findViolations } from './check-structure.mjs';

// Built from parts so that this file does not match its own rules.
const oldPrefix = ['--prefix', 'nest'].join(' ');
const oldImage = ['swarmloop', 'nest'].join('-');
const oldNested = ['swarmloop', 'nested'].join('-');

const rules = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'structure-rules.json'), 'utf8'));

function makeRoot(files) {
  const root = mkdtempSync(join(tmpdir(), 'structure-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

test('reports a forbidden folder that is present', () => {
  const root = makeRoot({});
  mkdirSync(join(root, 'nest'));

  const violations = findViolations({ root, rules, files: [] });

  assert.equal(violations.length, 1);
  assert.match(violations[0], /^nest: must not exist/);
});

test('reports a package lockfile left in a workspace folder', () => {
  const root = makeRoot({ 'server/package-lock.json': '{}\n' });

  const violations = findViolations({ root, rules, files: [] });

  assert.equal(violations.length, 1);
  assert.match(violations[0], /^server\/package-lock\.json: must not exist/);
});

test('reports a --prefix match on an old package name', () => {
  const files = { 'package.json': `{ "build": "npm run build ${oldPrefix}" }\n` };
  const root = makeRoot(files);

  const violations = findViolations({ root, rules, files: ['package.json'] });

  assert.equal(violations.length, 1);
  assert.match(violations[0], /^package\.json:1:/);
});

test('reports an old image name match', () => {
  const files = { 'docker-compose.yml': `services:\n  server:\n    image: ${oldImage}\n` };
  const root = makeRoot(files);

  const violations = findViolations({ root, rules, files: ['docker-compose.yml'] });

  assert.equal(violations.length, 1);
  assert.match(violations[0], /^docker-compose\.yml:3:/);
});

test('does not match a temp directory name that only starts with the old name', () => {
  const files = { 'server/src/worktree.spec.ts': `const dir = '${oldNested}-';\n` };
  const root = makeRoot(files);

  const violations = findViolations({ root, rules, files: ['server/src/worktree.spec.ts'] });

  assert.deepEqual(violations, []);
});

test('skips files under docs/refactor', () => {
  const files = { 'docs/refactor/21.md': `run ${oldPrefix}\n` };
  const root = makeRoot(files);

  const violations = findViolations({ root, rules, files: ['docs/refactor/21.md'] });

  assert.deepEqual(violations, []);
});
