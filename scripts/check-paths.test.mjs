import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { unmatchedPaths } from './check-paths.mjs';

test('reports a paths entry that matches no file', () => {
  const root = mkdtempSync(join(tmpdir(), 'swarmloop-check-paths-'));
  try {
    execFileSync('git', ['-C', root, 'init', '-q']);
    mkdirSync(join(root, 'server'));
    writeFileSync(join(root, 'server', 'a.ts'), 'a\n');
    writeFileSync(
      join(root, '.swarmloop.json'),
      JSON.stringify({
        checks: [
          { run: 'npm test', name: 'tests', paths: ['server/', 'renamed/', 'gone.env'] },
          { run: 'npx eslint .' },
        ],
      }),
    );
    assert.deepEqual(unmatchedPaths(root), ['tests: renamed/', 'tests: gone.env']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('every paths entry of this repository matches a file', () => {
  assert.deepEqual(unmatchedPaths(resolve(dirname(fileURLToPath(import.meta.url)), '..')), []);
});
