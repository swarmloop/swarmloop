import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const eslint = new ESLint({ cwd: root });

async function messages(filePath, code, ruleId = 'main-thread/no-sync-directory-work') {
  const [result] = await eslint.lintText(code, { filePath: join(root, filePath) });
  return result.messages.filter((message) => message.ruleId === ruleId);
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

const PROCESS_RULE = 'main-thread/no-sync-child-process';
const PROCESS_FILES = ['server/src/pipeline/x.ts', 'server/src/core/attempt-output.ts'];

test('fails an execFileSync import from child_process and node:child_process', async () => {
  for (const source of ['child_process', 'node:child_process']) {
    const code = `import { execFileSync } from '${source}';\nexport const run = (): string => execFileSync('git').toString();\n`;
    for (const file of PROCESS_FILES) {
      const found = await messages(file, code, PROCESS_RULE);
      assert.equal(found.length, 1, `${source} ${file}`);
      assert.match(found[0].message, /execFile, spawn/);
    }
  }
});

test('fails execSync and spawnSync imports', async () => {
  for (const name of ['execSync', 'spawnSync']) {
    const code = `import { ${name} } from 'child_process';\nexport const run = (): unknown => ${name}('ls');\n`;
    assert.equal((await messages('server/src/pipeline/x.ts', code, PROCESS_RULE)).length, 1, name);
  }
});

test('fails a child_process.spawnSync member call', async () => {
  const code =
    "import * as child_process from 'child_process';\nexport const run = (): unknown => child_process.spawnSync('ls');\n";
  assert.equal((await messages('server/src/pipeline/x.ts', code, PROCESS_RULE)).length, 1);
});

test('allows a spec and the async execFile', async () => {
  const sync = "import { execFileSync } from 'child_process';\nexport const run = (): unknown => execFileSync('ls');\n";
  assert.equal((await messages('server/src/pipeline/x.spec.ts', sync, PROCESS_RULE)).length, 0);
  const async = "import { execFile } from 'child_process';\nexport const run = (): unknown => execFile('ls');\n";
  assert.equal((await messages('server/src/pipeline/x.ts', async, PROCESS_RULE)).length, 0);
});
