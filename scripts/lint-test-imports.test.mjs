import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eslint = new ESLint({ cwd: root });

async function found(filePath, code) {
  const [result] = await eslint.lintText(code, { filePath: join(root, filePath) });
  return result.messages.filter((message) => message.ruleId === '@typescript-eslint/no-restricted-imports');
}

const LIBRARIES = ['vitest', 'jest', '@testing-library/react', '@testing-library/user-event', '@nestjs/testing'];

test('fails a file that is not test code and imports a test library', async () => {
  for (const library of LIBRARIES) {
    for (const filePath of [
      'dashboard/lib/format.ts',
      'dashboard/features/stats/chart.tsx',
      'server/src/api/stats.ts',
    ]) {
      const messages = await found(filePath, `import { thing } from '${library}';\nexport const used = thing;\n`);

      assert.equal(messages.length, 1, `${filePath} ${library}`);
    }
  }
});

test('allows test files and test helpers to import a test library', async () => {
  const code = "import { vi } from 'vitest';\nexport const used = vi;\n";
  for (const filePath of [
    'dashboard/features/stats/chart.test.tsx',
    'dashboard/test/raw-json.ts',
    'dashboard/vitest.setup.ts',
    'server/src/api/stats.spec.ts',
    'server/src/history/repository.spec-helpers.ts',
    'server/src/testing/test-app.ts',
    'server/test/e2e/golden-path.e2e.spec.ts',
  ]) {
    assert.deepEqual(await found(filePath, code), [], filePath);
  }
});
