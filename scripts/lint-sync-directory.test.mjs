import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eslint = new ESLint({ cwd: root });

async function messages(filePath, code) {
  const [result] = await eslint.lintText(code, { filePath: join(root, filePath) });
  return result.messages.filter((message) => message.ruleId === 'main-thread/no-sync-directory-work');
}

const FILES = ['server/src/pipeline/x.ts', 'server/src/sandbox/sandbox.service.ts'];

test('fails a readdirSync import', async () => {
  const code = "import { readdirSync } from 'fs';\nexport const names = (): string[] => readdirSync('.');\n";
  for (const file of FILES) {
    const found = await messages(file, code);
    assert.equal(found.length, 1, file);
    assert.match(found[0].message, /fs\/promises/);
  }
});

test('fails an fs.rmSync call', async () => {
  const code =
    "import * as fs from 'node:fs';\nexport function drop(): void {\n  fs.rmSync('x', { recursive: true });\n}\n";
  for (const file of FILES) {
    assert.equal((await messages(file, code)).length, 1, file);
  }
});

test('fails cpSync and opendirSync', async () => {
  for (const name of ['cpSync', 'opendirSync']) {
    const code = `import { ${name} } from 'fs';\nexport const go = (): unknown => ${name}('a', 'b');\n`;
    assert.equal((await messages('server/src/pipeline/x.ts', code)).length, 1, name);
  }
});

test('allows the async form from fs/promises', async () => {
  const code =
    "import { readdir, rm } from 'fs/promises';\nexport async function go(): Promise<void> {\n  await readdir('.');\n  await rm('x', { recursive: true });\n}\n";
  assert.equal((await messages('server/src/pipeline/x.ts', code)).length, 0);
});

test('allows a file in the allowlist and a spec', async () => {
  const code = "import { readdirSync } from 'fs';\nexport const names = (): string[] => readdirSync('.');\n";
  assert.equal((await messages('server/src/core/attempt-output.ts', code)).length, 0);
  assert.equal((await messages('server/src/pipeline/x.spec.ts', code)).length, 0);
});
