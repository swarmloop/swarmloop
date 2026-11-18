import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { complexityPlugin } from '../eslint.complexity-baseline.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = 'dashboard/features/run/example.ts';

// A function body of complexity n has n-1 branches.
const body = (number) => 'if (a) {}\n'.repeat(number - 1);
const fn = (name, number) => `export function ${name}(a: boolean) {\n${body(number)}}\n`;

async function lint(code, baseline) {
  const options = { max: 20, baseline };
  const eslint = new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: [
      {
        files: ['**/*.ts'],
        languageOptions: { parser: (await import('@typescript-eslint/parser')).default },
        plugins: { local: complexityPlugin },
        rules: { 'local/complexity': ['error', options], 'local/complexity-baseline-leave': ['warn', options] },
      },
    ],
  });
  const [result] = await eslint.lintText(code, { filePath: join(root, FILE) });
  const by = (ruleId) => result.messages.filter((message) => message.ruleId === ruleId);
  return { over: by('local/complexity'), leave: by('local/complexity-baseline-leave') };
}

test('a new function of complexity 21 fails with its name, file, number and limit', async () => {
  const { over } = await lint(fn('grown', 21), {});
  assert.equal(over.length, 1);
  assert.match(
    over[0].message,
    /Function 'grown' in dashboard\/features\/run\/example\.ts has complexity 21; its limit is 20/,
  );
});

test('a listed function that grows from 55 to 56 fails', async () => {
  const { over } = await lint(fn('big', 56), { [FILE]: { "Function 'big'": 55 } });
  assert.equal(over.length, 1);
  assert.match(over[0].message, /has complexity 56; its limit is 55/);
});

test('a listed function that falls to 20 passes and is reported as leaving the list', async () => {
  const { over, leave } = await lint(fn('big', 20), { [FILE]: { "Function 'big'": 55 } });
  assert.equal(over.length, 0);
  assert.equal(leave.length, 1);
  assert.match(leave[0].message, /Function 'big' in .* it leaves the list/);
});

test('a listed function that is gone is reported as leaving the list', async () => {
  const { leave } = await lint(fn('small', 3), { [FILE]: { "Function 'big'": 55 } });
  assert.equal(leave.length, 1);
  assert.match(leave[0].message, /Function 'big'.*no longer in the file/);
});

test('an unchanged listed function passes', async () => {
  const { over, leave } = await lint(fn('big', 55), { [FILE]: { "Function 'big'": 55 } });
  assert.deepEqual([over.length, leave.length], [0, 0]);
});

test('a function at 20 that is not listed passes', async () => {
  const { over, leave } = await lint(fn('edge', 20), {});
  assert.deepEqual([over.length, leave.length], [0, 0]);
});

test('an anonymous function is listed under the name of the function around it', async () => {
  const code = `export function Outer(a: boolean) {\n  return [1].map(() => {\n${body(30)}  });\n}\n`;
  const baseline = { [FILE]: { "Function 'Outer' > Arrow function": 30 } };
  const { over, leave } = await lint(code, baseline);
  assert.deepEqual([over.length, leave.length], [0, 0]);
  const grown = await lint(code.replace('if (a) {}\n', 'if (a) {}\nif (a) {}\n'), baseline);
  assert.match(grown.over[0].message, /Function 'Outer' > Arrow function in .* has complexity 31; its limit is 30/);
});

test('two unnamed functions side by side are told apart, and only the listed one gets the listed limit', async () => {
  const code = `export function Outer(a: boolean) {\n  const first = () => {\n${body(30)}  };\n  const second = () => {\n${body(25)}  };\n  return [first, second];\n}\n`;
  const baseline = { [FILE]: { "Function 'Outer' > Arrow function": 30 } };
  const { over, leave } = await lint(code, baseline);
  assert.equal(over.length, 1);
  assert.match(over[0].message, /Function 'Outer' > Arrow function #2 in .* has complexity 25; its limit is 20/);
  assert.equal(leave.length, 0);
});
