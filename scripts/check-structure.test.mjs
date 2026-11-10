import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findViolations } from './check-structure.mjs';

// Built from parts so that this file does not match its own rules.
const oldPrefix = ['--prefix', 'nest'].join(' ');
const oldImage = ['swarmloop', 'nest'].join('-');
const oldNested = ['swarmloop', 'nested'].join('-');

const rules = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'structure-rules.json'), 'utf8'));

function makeRoot(files) {
  const root = mkdtempSync(join(tmpdir(), 'structure-'));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

test('reports a forbidden folder that is present', () => {
  const root = makeRoot({});
  mkdirSync(join(root, 'nest'));

  const violations = findViolations({ root, rules, files: [] });

  assert.equal(violations.length, 1);
  assert.match(violations[0], /^nest: must not exist/);
});

test('reports a --prefix match on an old package name', () => {
  const files = { 'package.json': `{ "build": "npm run build ${oldPrefix}" }\n` };
  const root = makeRoot(files);

  const violations = findViolations({ root, rules, files: ['package.json'] });

  assert.equal(violations.length, 1);
  assert.match(violations[0], /^package\.json:1:/);
});

test('reports an old image name match', () => {
  const files = { 'docker-compose.yml': `services:\n  server:\n    image: ${oldImage}\n` };
  const root = makeRoot(files);

  const violations = findViolations({ root, rules, files: ['docker-compose.yml'] });

  assert.equal(violations.length, 1);
  assert.match(violations[0], /^docker-compose\.yml:3:/);
});

test('does not match a temp directory name that only starts with the old name', () => {
  const files = { 'server/src/worktree.spec.ts': `const dir = '${oldNested}-';\n` };
  const root = makeRoot(files);

  const violations = findViolations({ root, rules, files: ['server/src/worktree.spec.ts'] });

  assert.deepEqual(violations, []);
});

test('skips files under docs/refactor', () => {
  const files = { 'docs/refactor/21.md': `run ${oldPrefix}\n` };
  const root = makeRoot(files);

  const violations = findViolations({ root, rules, files: ['docs/refactor/21.md'] });

  assert.deepEqual(violations, []);
});

test('forbidInFile reports the old sentence in that file only and not in another file', () => {
  const { file, pattern } = rules.forbidInFile[0];
  const sentence = `${pattern}.\n`;
  const root = makeRoot({ [file]: sentence, 'skills/other/SKILL.md': sentence });

  const violations = findViolations({ root, rules, files: [file, 'skills/other/SKILL.md'] });

  assert.equal(violations.length, 1);
  assert.match(violations[0], new RegExp(`^${file}:1:`));
});

test('compose.yml pulls its images: no build and no source path (compose.build.yml builds)', () => {
  const composeRules = {
    ...rules,
    forbidInFile: rules.forbidInFile.filter(({ file }) => file === 'compose.yml'),
  };
  const check = (text) => findViolations({ root: makeRoot({ 'compose.yml': text }), rules: composeRules, files: [] });

  assert.equal(check('services:\n  server:\n    build:\n      context: .\n').length > 0, true);
  assert.equal(check('services:\n  server:\n    volumes:\n      - ./server:/app\n').length, 1);
  assert.deepEqual(
    check(
      'services:\n  server:\n    image: ghcr.io/swarmloop/swarmloop-server:1\n    volumes:\n      - ${HOME_DIR}/data:/app/data\n',
    ),
    [],
  );
});

test('release.yml reacts to tags only', () => {
  const workflowRules = {
    ...rules,
    forbidInFile: rules.forbidInFile.filter(({ file }) => file === '.github/workflows/release.yml'),
  };
  const check = (text) =>
    findViolations({ root: makeRoot({ '.github/workflows/release.yml': text }), rules: workflowRules, files: [] });

  assert.deepEqual(check("on:\n  push:\n    tags: ['v*']\n"), []);
  assert.equal(check('on:\n  push:\n    branches: [main]\n').length, 1);
  assert.equal(check('on:\n  pull_request:\n').length, 1);
  assert.equal(check("on:\n  schedule:\n    - cron: '0 0 * * *'\n").length, 1);
});

test('forbidOutside reports an image name outside the resolver and lets the resolver and its spec keep it', () => {
  const name = ['swarmloop', 'agent', 'claude'].join('-');
  const files = {
    'server/src/sandbox/foo.ts': `const image = '${name}';\n`,
    'server/src/sandbox/image-resolver.ts': `const image = '${name}';\n`,
    'server/src/sandbox/image-resolver.spec.ts': `const image = '${name}';\n`,
    'server/src/agent/foo.spec.ts': `mkdtemp(join(tmpdir(), '${name}-'));\n`,
    'docker-compose.yml': `image: ${name}\n`,
  };
  const root = makeRoot(files);

  const violations = findViolations({ root, rules, files: Object.keys(files) });

  assert.equal(violations.length, 1);
  assert.match(violations[0], /^server\/src\/sandbox\/foo\.ts:1:/);
});

test('forbidOutside reports a step, an environment or an agent file that reads RUNTIME or a model env itself, and lets a string in a spec helper be', () => {
  const files = {
    'server/src/steps/plan/plan.step.ts': 'const model = env.MODEL_PLAN;\n',
    'server/src/steps/shared/launch.ts': 'const runtime = this.config.env.RUNTIME;\n',
    'server/src/steps/plan/plan.spec-helpers.ts': "const lines = ['RUNTIME=cursor', 'MODEL_PLAN=m'];\n",
    'server/src/environment/project-environments.ts': 'const runtime = this.config.env.RUNTIME;\n',
    'server/src/agent/spend.ts': 'const model = env.MODEL_PLAN;\n',
    'server/src/config/agents.ts': 'const model = env.MODEL_PLAN;\n',
  };
  const root = makeRoot(files);

  const violations = findViolations({ root, rules, files: Object.keys(files) });

  assert.equal(violations.length, 4);
  assert.match(violations[0], /^server\/src\/steps\/plan\/plan\.step\.ts:1:/);
  assert.match(violations[1], /^server\/src\/steps\/shared\/launch\.ts:1:/);
  assert.match(violations[2], /^server\/src\/environment\/project-environments\.ts:1:/);
  assert.match(violations[3], /^server\/src\/agent\/spend\.ts:1:/);
});
