import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptsDir, '..');
const script = join(scriptsDir, 'ci-tools.sh');

// Replaces npm with a stub that records its arguments and working directory.
function stubNpm() {
  const dir = mkdtempSync(join(tmpdir(), 'ci-tools-'));
  const record = join(dir, 'npm-call.txt');
  writeFileSync(join(dir, 'npm'), `#!/usr/bin/env bash\n{ pwd; printf '%s\\n' "$@"; } > "${record}"\n`);
  chmodSync(join(dir, 'npm'), 0o755);
  return { env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, record };
}

test('exits 1 for an unknown group', () => {
  const { env, record } = stubNpm();

  const result = spawnSync('bash', [script, 'unknown'], { env, encoding: 'utf8' });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown group 'unknown'/);
  assert.throws(() => readFileSync(record, 'utf8'), { code: 'ENOENT' });
});

test('installs the pinned lint packages in the repository root', () => {
  const { env, record } = stubNpm();

  const result = spawnSync('bash', [script, 'lint'], { env, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(record, 'utf8').split('\n').filter(Boolean), [
    repoRoot,
    'install',
    '--no-save',
    '--no-package-lock',
    '--no-audit',
    '--no-fund',
    'eslint@9',
    '@eslint/js@9',
    'typescript-eslint@8',
    'globals@16',
    'eslint-config-prettier@10',
    'prettier@3',
    '@next/eslint-plugin-next@15',
    'eslint-plugin-react-hooks@5',
    'eslint-plugin-jsx-a11y@6',
    'typescript@5',
  ]);
});

test('installs the pinned dashboard test packages in dashboard/', () => {
  const { env, record } = stubNpm();

  const result = spawnSync('bash', [script, 'dashboard-test'], { env, encoding: 'utf8' });

  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(record, 'utf8').split('\n').filter(Boolean), [
    join(repoRoot, 'dashboard'),
    'install',
    '--no-save',
    '--no-package-lock',
    '--no-audit',
    '--no-fund',
    'vitest@3',
    'jsdom@26',
    '@vitejs/plugin-react@4',
    '@testing-library/react@16',
    '@testing-library/dom@10',
    '@testing-library/user-event@14',
    '@testing-library/jest-dom@6',
  ]);
});
