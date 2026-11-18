import assert from 'node:assert/strict';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');

const lintTools = [
  'eslint',
  '@eslint/js',
  'typescript-eslint',
  'globals',
  'eslint-config-prettier',
  'prettier',
  '@next/eslint-plugin-next',
  'eslint-plugin-react-hooks',
  'eslint-plugin-jsx-a11y',
  'eslint-plugin-boundaries',
  'typescript',
  'knip',
  'madge',
];
const dashboardTools = [
  'vitest',
  'jsdom',
  '@vitejs/plugin-react',
  '@testing-library/react',
  '@testing-library/dom',
  '@testing-library/user-event',
  '@testing-library/jest-dom',
];

// Builds a temporary repository layout with a copy of the script, and replaces npm with a stub that records
// its arguments and working directory.
function setup() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ci-tools-')));
  mkdirSync(join(root, 'scripts'));
  for (const file of ['scripts/ci-tools.sh', 'package.json', 'package-lock.json']) {
    copyFileSync(join(repoRoot, file), join(root, file));
  }
  const bin = join(root, 'bin');
  const record = join(root, 'npm-call.txt');
  mkdirSync(bin);
  writeFileSync(join(bin, 'npm'), `#!/usr/bin/env bash\n{ pwd; printf '%s\\n' "$@"; } > "${record}"\n`);
  chmodSync(join(bin, 'npm'), 0o755);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  return {
    root,
    record,
    run: (group) => spawnSync('bash', [join(root, 'scripts', 'ci-tools.sh'), group], { env, encoding: 'utf8' }),
  };
}

function assertPinned(names) {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(repoRoot, 'package-lock.json'), 'utf8'));
  for (const name of names) {
    const wanted = manifest.devDependencies[name];
    assert.match(wanted, /^\d+\.\d+\.\d+$/, `${name} is not pinned to an exact version`);
    assert.equal(lock.packages[`node_modules/${name}`].version, wanted, `${name} differs in the lockfile`);
  }
}

function assertInstallsPinnedTree(group, names) {
  const { root, run, record } = setup();

  const result = run(group);

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(record, 'utf8').split('\n').filter(Boolean), [
    root,
    'ci',
    '--omit=peer',
    '--no-audit',
    '--no-fund',
  ]);
  assertPinned(names);
}

test('exits 1 for an unknown group', () => {
  const { run, record } = setup();

  const result = run('unknown');

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown group 'unknown'/);
  assert.throws(() => readFileSync(record, 'utf8'), { code: 'ENOENT' });
});

test('installs the pinned lint packages in the repository root', () => {
  assertInstallsPinnedTree('lint', lintTools);
});

test('installs the pinned dashboard test packages in dashboard/', () => {
  assertInstallsPinnedTree('dashboard-test', dashboardTools);
});

test("links the dashboard copies of the tools' peers", () => {
  const { root, run } = setup();
  for (const name of ['react', 'react-dom']) {
    mkdirSync(join(root, 'dashboard', 'node_modules', name), { recursive: true });
  }

  const result = run('lint');

  assert.equal(result.status, 0, result.stderr);
  for (const name of ['react', 'react-dom']) {
    assert.equal(realpathSync(join(root, 'node_modules', name)), join(root, 'dashboard', 'node_modules', name));
  }
  assert.equal(existsSync(join(root, 'node_modules', '@types', 'react')), false);
});
