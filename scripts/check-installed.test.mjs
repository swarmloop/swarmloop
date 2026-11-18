import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = join(dirname(fileURLToPath(import.meta.url)), 'check-installed.mjs');

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

// Writes a tree named "dashboard" with a lockfile and the installed packages; `installed` maps a path under
// node_modules to a version.
function fixture(installed, locked = {}) {
  const dir = join(mkdtempSync(join(tmpdir(), 'check-installed-')), 'dashboard');
  const packages = {
    'node_modules/left-pad': { version: '1.3.0' },
    'node_modules/@tanstack/query-core': { version: '5.107.0' },
    'node_modules/next/node_modules/postcss': { version: '8.4.31' },
    ...locked,
  };
  writeJson(join(dir, 'package-lock.json'), { lockfileVersion: 3, packages: { '': {}, ...packages } });
  const versions = {
    'left-pad': '1.3.0',
    '@tanstack/query-core': '5.107.0',
    'next/node_modules/postcss': '8.4.31',
    ...installed,
  };
  for (const [name, version] of Object.entries(versions)) {
    if (version === null) continue;
    const folder = join(dir, 'node_modules', name);
    writeJson(join(folder, 'package.json'), { name, version });
  }
  return dir;
}

function check(dir) {
  return spawnSync('node', [script, basename(dir)], { encoding: 'utf8', cwd: dirname(dir) });
}

// Node may print its own warnings to stderr; only the script's lines count.
const reported = (result) => result.stderr.split('\n').filter((line) => line.startsWith('dashboard:'));

test('passes when the installed tree equals the lockfile', () => {
  const result = check(fixture({}));

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /dashboard: installed packages equal package-lock.json/);
});

test('fails naming a package that moved', () => {
  const result = check(fixture({ '@tanstack/query-core': '5.108.0' }));

  assert.equal(result.status, 1);
  assert.deepEqual(reported(result), ['dashboard: @tanstack/query-core 5.108.0 installed, lockfile 5.107.0']);
});

test('fails for a missing package and an extra package, not for a missing optional one', () => {
  const dir = fixture(
    { 'left-pad': null, 'extra-pkg': '2.0.0' },
    { 'node_modules/fsevents': { version: '2.3.3', optional: true } },
  );

  const result = check(dir);

  assert.equal(result.status, 1);
  assert.deepEqual(reported(result), [
    'dashboard: extra-pkg 2.0.0 installed, not in lockfile',
    'dashboard: left-pad missing, lockfile 1.3.0',
  ]);
});

test('fails without a lockfile and without an argument', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-installed-'));

  const noLock = spawnSync('node', [script, 'missing'], { encoding: 'utf8', cwd: dir });
  const noArg = spawnSync('node', [script], { encoding: 'utf8', cwd: dir });

  assert.equal(noLock.status, 1);
  assert.match(noLock.stderr, /missing: no package-lock.json/);
  assert.equal(noArg.status, 1);
  assert.match(noArg.stderr, /usage/);
});
