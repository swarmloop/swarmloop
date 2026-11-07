import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eslint = new ESLint({ cwd: root });

async function messages(filePath, code) {
  const [result] = await eslint.lintText(code, { filePath: join(root, filePath) });
  return result.messages.filter((message) => message.ruleId === 'no-restricted-syntax').map((item) => item.message);
}

const WRITE = 'export function move(run: { status: string }): void {\n  run.status = "failed";\n}\n';

test('fails an assignment to a run-state field outside history/run-state.ts', async () => {
  const found = await messages('server/src/pipeline/move.ts', WRITE);

  assert.equal(found.length, 1);
  assert.match(found[0], /history\/run-state\.ts/);
});

test('fails every field of the run state', async () => {
  for (const field of ['currentStep', 'ownerPid', 'ownerInstance', 'activeAttempt', 'state', 'stateReason']) {
    const code = `export function move(run: { ${field}: unknown }): void {\n  run.${field} = null;\n}\n`;

    assert.equal((await messages('server/src/api/move.ts', code)).length, 1, field);
  }
});

test('fails the assignment in step code too', async () => {
  const found = await messages('server/src/steps/commit/move.ts', WRITE);

  assert.equal(found.length, 1);
});

test('allows the assignment in history/run-state.ts and in specs', async () => {
  assert.deepEqual(await messages('server/src/history/run-state.ts', WRITE), []);
  assert.deepEqual(await messages('server/src/pipeline/move.spec.ts', WRITE), []);
  assert.deepEqual(await messages('server/src/testing/move.spec-helpers.ts', WRITE), []);
});

test('allows an assignment to another field', async () => {
  const code = 'export function move(run: { prompt: string }): void {\n  run.prompt = "x";\n}\n';

  assert.deepEqual(await messages('server/src/pipeline/move.ts', code), []);
});
