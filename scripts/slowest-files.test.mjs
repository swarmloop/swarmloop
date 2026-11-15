import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatSlowestFiles } from './slowest-files.mjs';

const root = '/repo/server';

test('orders files from the slowest to the fastest', () => {
  const block = formatSlowestFiles(root, [
    { path: '/repo/server/src/a.spec.ts', ms: 1000 },
    { path: '/repo/server/src/b.spec.ts', ms: 3000 },
    { path: '/repo/server/src/c.spec.ts', ms: 2000 },
  ]);
  const paths = block.split('\n').filter((line) => line.includes('.spec.ts'));
  assert.deepEqual(
    paths.map((line) => line.trim().split(/\s+/)[2]),
    ['src/b.spec.ts', 'src/c.spec.ts', 'src/a.spec.ts'],
  );
});

test('keeps only the ten slowest of twelve', () => {
  const files = Array.from({ length: 12 }, (_, i) => ({
    path: `/repo/server/src/f${i}.spec.ts`,
    ms: (i + 1) * 100,
  }));
  const block = formatSlowestFiles(root, files);
  assert.equal(block.split('\n').filter((line) => line.includes('.spec.ts')).length, 10);
  assert.ok(block.includes('src/f11.spec.ts'));
  assert.ok(!block.includes('src/f0.spec.ts'));
  assert.ok(!block.includes('src/f1.spec.ts'));
});

test('shows paths relative to the package and times in seconds', () => {
  const block = formatSlowestFiles(root, [{ path: '/repo/server/src/x/y.spec.ts', ms: 1500 }]);
  assert.ok(block.startsWith('slowest test files\n'));
  assert.match(block, /1\.5 s {2}src\/x\/y\.spec\.ts/);
  assert.ok(!block.includes('/repo/server'));
});

test('prints nothing for an empty run', () => {
  assert.equal(formatSlowestFiles(root, []), '');
});
