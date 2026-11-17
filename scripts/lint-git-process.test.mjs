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

const CALL =
  "import { execFile } from 'child_process';\nexport function run(): void {\n  execFile('git', ['status']);\n}\n";

test('fails a git process started outside the git runners', async () => {
  const found = await messages('server/src/pipeline/x.ts', CALL);

  assert.equal(found.length, 1);
  assert.match(found[0], /git\.ts, worktree-tree\.ts or sandbox\/project-git\.ts/);
});

test('fails a call split over several lines', async () => {
  const code =
    "import { execFile } from 'child_process';\nexport function run(): void {\n  execFile(\n    'git',\n    ['status'],\n  );\n}\n";

  assert.equal((await messages('server/src/pipeline/x.ts', code)).length, 1);
});

test('fails execFileSync, spawn and a member call', async () => {
  for (const call of ["execFileSync('git', [])", "spawn('git', [])", "child_process.execFile('git', [])"]) {
    const code = `export function run(): void {\n  ${call};\n}\n`;

    assert.equal((await messages('server/src/pipeline/x.ts', code)).length, 1, call);
  }
});

test('fails a promisified execFile alias', async () => {
  const code =
    "import { execFile } from 'child_process';\nimport { promisify } from 'util';\nconst run = promisify(execFile);\nexport async function go(): Promise<void> {\n  await run('git', ['status']);\n}\n";

  assert.equal((await messages('server/src/environment/x.ts', code)).length, 1);
});

test('fails the call in step code, the run state module and the config layer', async () => {
  for (const file of ['server/src/steps/commit/x.ts', 'server/src/history/run-state.ts', 'server/src/config/x.ts']) {
    assert.equal((await messages(file, CALL)).length, 1, file);
  }
});

const BARE = "export function run(): void {\n  execFile('git', ['status']);\n}\n";

test('allows the call in the three git runners, in specs and in the git fixture', async () => {
  for (const file of [
    'server/src/git/git.ts',
    'server/src/git/worktree-tree.ts',
    'server/src/sandbox/project-git.ts',
    'server/src/pipeline/x.spec.ts',
    'server/src/testing/git-fixture.ts',
  ]) {
    assert.deepEqual(await messages(file, BARE), [], file);
  }
});

test('allows a process other than git', async () => {
  const code =
    "import { execFile } from 'child_process';\nexport function run(): void {\n  execFile('docker', ['ps']);\n}\n";

  assert.deepEqual(await messages('server/src/pipeline/x.ts', code), []);
});
