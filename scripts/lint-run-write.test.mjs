import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eslint = new ESLint({ cwd: root });

async function messages(filePath, code) {
  const [result] = await eslint.lintText(code, { filePath: join(root, filePath) });
  return result.messages.filter((message) => message.ruleId === 'run-write/no-run-write').map((item) => item.message);
}

const INJECT = 'class X {\n  constructor(@InjectRepository(RunEntity) private readonly runs: unknown) {}\n}\n';
const UPDATE =
  'export async function move(db: any): Promise<void> {\n  await db.getRepository(RunEntity).update({}, {});\n}\n';
const SAVE_RUN =
  'export async function move(runs: any, run: unknown): Promise<void> {\n  await runs.saveRun(run);\n}\n';

test('fails a repository of RunEntity and an update through it in pipeline and step code', async () => {
  for (const path of ['server/src/pipeline/x.ts', 'server/src/steps/x.ts']) {
    const injected = await messages(path, INJECT);
    const updated = await messages(path, UPDATE);

    assert.equal(injected.length, 1, path);
    assert.match(injected[0], /RunRepository\.change/);
    assert.equal(updated.length, 1, path);
  }
});

test('fails a call of saveRun', async () => {
  assert.equal((await messages('server/src/pipeline/x.ts', SAVE_RUN)).length, 1);
});

test('fails every write call whose first argument is RunEntity', async () => {
  for (const call of ['update', 'insert', 'into', 'save', 'delete', 'increment', 'upsert']) {
    const code = `export async function move(db: any): Promise<void> {\n  await db.${call}(RunEntity, {});\n}\n`;

    assert.equal((await messages('server/src/api/x.ts', code)).length, 1, call);
  }
});

test('allows the same code in history and in a spec', async () => {
  for (const path of ['server/src/history/x.ts', 'server/src/pipeline/x.spec.ts']) {
    assert.deepEqual(await messages(path, INJECT), [], path);
    assert.deepEqual(await messages(path, UPDATE), [], path);
  }
});

test('allows a repository of another entity', async () => {
  const code = UPDATE.replace('RunEntity', 'VisitEntity');

  assert.deepEqual(await messages('server/src/pipeline/x.ts', code), []);
});
