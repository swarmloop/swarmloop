import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { PROCESS_EXCEPTIONS } from '../eslint.spec-rules.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eslint = new ESLint({ cwd: root });

async function found(filePath, code) {
  const [result] = await eslint.lintText(code, { filePath: join(root, filePath) });
  return result.messages.filter((message) => message.ruleId === 'no-restricted-syntax');
}

const TEST_FILES = [
  'server/src/api/stats.spec.ts',
  'server/src/history/repository.spec-helpers.ts',
  'server/src/testing/fake-ci.ts',
  'dashboard/features/stats/chart.test.tsx',
  'dashboard/test/raw-json.ts',
];

test('flags real waiting in every kind of test file', async () => {
  const waits = [
    'setTimeout(() => {}, 10);\n',
    'setInterval(() => {}, 10);\n',
    "import { setTimeout as sleep } from 'timers/promises';\nexport const used = sleep;\n",
    "import { setTimeout as sleep } from 'node:timers/promises';\nexport const used = sleep;\n",
    'while (Date.now() < 5) {}\n',
    'for (let i = 0; i < 1; i++) { performance.now(); }\n',
    'do {} while (Date.now() < 5);\n',
  ];
  for (const filePath of TEST_FILES) {
    for (const code of waits) {
      assert.equal((await found(filePath, code)).length, 1, `${filePath}: ${code}`);
    }
  }
});

test('allows setImmediate and a clock read outside a loop', async () => {
  for (const filePath of TEST_FILES) {
    assert.deepEqual(await found(filePath, 'setImmediate(() => {});\nexport const at = Date.now();\n'), [], filePath);
  }
});

test('flags a child_process import and require in a spec and a helper', async () => {
  const codes = [
    "import { execFileSync } from 'child_process';\nexport const used = execFileSync;\n",
    "import { execFileSync } from 'node:child_process';\nexport const used = execFileSync;\n",
    "const { execFileSync } = require('child_process');\nexport const used = execFileSync;\n",
    "const { execFileSync } = require('node:child_process');\nexport const used = execFileSync;\n",
  ];
  for (const filePath of ['server/src/api/stats.spec.ts', 'server/src/history/repository.spec-helpers.ts']) {
    for (const code of codes) {
      assert.equal((await found(filePath, code)).length, 1, `${filePath}: ${code}`);
    }
  }
});

test('allows a process in git-fixture, a whole-flow spec and each listed exception', async () => {
  const code = "import { execFileSync } from 'node:child_process';\nexport const used = execFileSync;\n";
  const allowed = [
    'server/src/testing/git-fixture.ts',
    'server/src/testing/flow-heal.e2e.spec.ts',
    'server/test/e2e/golden-path.e2e.spec.ts',
    ...PROCESS_EXCEPTIONS,
  ];
  for (const filePath of allowed) {
    assert.deepEqual(await found(filePath, code), [], filePath);
  }
});

test('lists exactly the specs that keep a real process, and each exists', () => {
  assert.equal(PROCESS_EXCEPTIONS.length, 4);
  for (const filePath of PROCESS_EXCEPTIONS) {
    assert.ok(existsSync(join(root, filePath)), filePath);
  }
});

test('still reports the clock in a testing file', async () => {
  assert.equal((await found('server/src/testing/fake-ci.ts', 'export const at = new Date();\n')).length, 1);
});

test('keeps the dashboard socket and visit-key rules in test files', async () => {
  const socket = 'socket.on("x", () => {});\n';
  for (const filePath of ['dashboard/features/stats/chart.test.tsx', 'dashboard/features/run/flow.test.tsx']) {
    assert.equal((await found(filePath, socket)).length, 1, filePath);
  }
  const key = 'export const view = (rows) => rows.map((row) => <li key={row.id} />);\n';
  assert.equal((await found('dashboard/features/run/flow.test.tsx', key)).length, 1);
});
