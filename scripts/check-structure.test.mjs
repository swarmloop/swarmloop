import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { findViolations } from './check-structure.mjs';

// Built from parts so that this file does not match its own rules.
const oldPrefix = ['--prefix', 'nest'].join(' ');
const oldImage = ['swarmloop', 'nest'].join('-');
const folder = ['node', 'modules'].join('_');
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

test('no compose file mounts data/ into the dashboard', () => {
  const composeRules = {
    ...rules,
    forbidInFile: rules.forbidInFile.filter(({ file }) => file.startsWith('compose')),
  };
  const check = (text) => findViolations({ root: makeRoot({ 'compose.yml': text }), rules: composeRules, files: [] });

  assert.equal(
    check(
      'services:\n  dashboard:\n    image: x\n    volumes:\n      - ${HOME}/data:/app/dashboard/public/run-logs:ro\n',
    ).length,
    1,
  );
  assert.deepEqual(check('services:\n  dashboard:\n    image: x\n'), []);
});

test('compose.yml permits the stack folder mount and the parent checkouts interpolation', () => {
  const composeRules = {
    ...rules,
    forbidInFile: rules.forbidInFile.filter(({ file }) => file === 'compose.yml'),
  };
  const check = (text) => findViolations({ root: makeRoot({ 'compose.yml': text }), rules: composeRules, files: [] });
  const stack =
    'services:\n  server:\n    image: x\n    environment:\n      - SWARMLOOP_ENV_FILE=/app/stack/.env\n    volumes:\n      - .:/app/stack:ro\n      - ${CHECKOUTS_ROOT:-..}:/checkouts\n';

  assert.deepEqual(check(stack), []);
  assert.equal(check(`${stack}      - ./server:/app\n`).length, 1);
  assert.equal(check(`${stack}      - ../repo:/x\n`).length, 1);
});

test('compose.override.yml may not mount data/ into the dashboard', () => {
  const composeRules = {
    ...rules,
    forbidInFile: rules.forbidInFile.filter(({ file }) => file.startsWith('compose')),
  };
  const check = (text) =>
    findViolations({ root: makeRoot({ 'compose.override.yml': text }), rules: composeRules, files: [] });

  assert.equal(
    check('services:\n  dashboard:\n    volumes:\n      - ./data:/app/dashboard/public/run-logs:ro\n').length,
    1,
  );
  assert.deepEqual(check('services:\n  dashboard:\n    build:\n      context: .\n'), []);
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

test('forbidOutside reports code that writes a log document and lets a spec and the live view be', () => {
  const files = {
    'server/src/steps/shared/model-visit.ts': "documents: [{ kind: 'log', fileName: '', body }],\n",
    'server/src/steps/shared/limit-failover.ts': "documents: [{ kind: ARTIFACTS.log.kind, fileName: '', body }],\n",
    'server/src/api/run-view/live.ts': "documents: [{ kind: 'log', attempt: 1, body }],\n",
    'server/src/api/runs-flow.service.spec.ts': "documents: [{ kind: 'log', fileName: '', body }],\n",
    'server/src/api/run-queries-log.ts': "document.kind === 'log'\n",
  };
  const root = makeRoot(files);

  const violations = findViolations({ root, rules, files: Object.keys(files) });

  assert.equal(violations.length, 2);
  assert.match(violations[0], /^server\/src\/steps\/shared\/model-visit\.ts:1:/);
  assert.match(violations[1], /^server\/src\/steps\/shared\/limit-failover\.ts:1:/);
});

test('forbidOutside lets only the checks step call the server checks, and a spec keep a mock of it', () => {
  const files = {
    'server/src/steps/checks/checks.step.ts': 'await this.environments.check(place);\n',
    'server/src/steps/implement/implement.step.ts': 'await this.environments.check(place);\n',
    'server/src/steps/implement/implement-improve.step.ts': 'this.environments.check(place)\n',
    'server/src/steps/implement/implement.step.spec.ts':
      "jest.spyOn(environments, 'check');\nenvironments.check(place);\n",
    'server/src/environment/project-environments.ts': 'environments.check(input);\n',
  };
  const root = makeRoot(files);

  const violations = findViolations({ root, rules, files: Object.keys(files) });

  assert.equal(violations.length, 2);
  assert.match(violations[0], /^server\/src\/steps\/implement\/implement\.step\.ts:1:/);
  assert.match(violations[1], /^server\/src\/steps\/implement\/implement-improve\.step\.ts:1:/);
});

test("forbidOutside reports a use of the agent launcher outside the door and the backlog planner's turn runner, and lets them and a spec keep it", () => {
  const use = "import { AgentLauncher } from './agent-launcher';\n";
  const files = {
    'server/src/steps/research/research.step.ts': use,
    'server/src/steps/shared/agent-door.ts': use,
    'server/src/pipeline/backlog/planner/turn-runner.ts': use,
    'server/src/steps/research/research.step.spec.ts': use,
  };
  const root = makeRoot(files);

  const violations = findViolations({ root, rules, files: Object.keys(files) });

  assert.equal(violations.length, 1);
  assert.match(violations[0], /^server\/src\/steps\/research\/research\.step\.ts:1:/);
});

test('forbidOutside reports a state derived outside the run state module and lets that module and its spec be', () => {
  const files = {
    'server/src/history/run-state.ts': 'function deriveState(run) {}\n',
    'server/src/history/run-state.spec.ts': "describe('deriveState', () => {});\n",
    'server/src/api/run-view/flow-waiting.ts': 'const { state } = deriveState(run, facts);\n',
    'server/src/pipeline/foo.spec.ts': 'expect(deriveState(run).state).toBe(x);\n',
    'server/src/pipeline/bar.ts': 'const { state } = storedState(run);\n',
  };
  const root = makeRoot(files);

  const violations = findViolations({ root, rules, files: Object.keys(files) });

  assert.equal(violations.length, 2);
  assert.match(violations[0], /^server\/src\/api\/run-view\/flow-waiting\.ts:1:/);
  assert.match(violations[1], /^server\/src\/pipeline\/foo\.spec\.ts:1:/);
});

test('forbidOutside reports a block code or an error document read in the four state readers and lets the display read and other files be', () => {
  const files = {
    'server/src/history/run-state.ts':
      'const code = blockCode(step, error);\nconst stored = readReason(run.stateReason);\n',
    'server/src/steps/shared/run-state-refresh.ts':
      "const documents = await latestDocuments([run.id], [...KINDS, 'error']);\n",
    'server/src/api/run-view/flow-waiting.ts': "const residual = latest(current, 'error') ?? null;\n",
    'server/src/steps/step-error-end.ts': 'const code = blockCode(step, error);\n',
  };
  const root = makeRoot(files);

  const violations = findViolations({ root, rules, files: Object.keys(files) });

  assert.equal(violations.length, 2);
  assert.match(violations[0], /^server\/src\/history\/run-state\.ts:1:/);
  assert.match(violations[1], /^server\/src\/steps\/shared\/run-state-refresh\.ts:1:/);
});

test('forbidOutside keeps the old phase name in the migration and nowhere else', () => {
  const old = ['brain', 'storm'].join('');
  const files = {
    'server/src/history/migrations/1795000000000-checks-step.ts': `name === '${old}'\n`,
    'server/src/history/migrations/checks-step.spec.ts': `['${old}']\n`,
    'server/src/contract/steps.ts': `${old}: ['prepare'],\n`,
    'dashboard/features/run/phases.ts': `${old}: 'planning',\n`,
  };
  const root = makeRoot(files);

  const violations = findViolations({ root, rules, files: Object.keys(files) });

  assert.equal(violations.length, 2);
  assert.match(violations[0], /^server\/src\/contract\/steps\.ts:1:/);
  assert.match(violations[1], /^dashboard\/features\/run\/phases\.ts:1:/);
});

test('forbidOutside reports the block size outside free-bytes.ts and lets that file keep it', () => {
  const line = `const bytes = stats.bavail * stats.${['b', 'size'].join('')};\n`;
  const files = { 'server/src/x.ts': line, 'server/src/core/free-bytes.ts': line };
  const root = makeRoot(files);

  const violations = findViolations({ root, rules, files: Object.keys(files) });

  assert.equal(violations.length, 1);
  assert.match(violations[0], /^server\/src\/x\.ts:1:/);
});

test('forbidOutside reports an ecosystem folder in product code and lets a spec and event.target be', () => {
  const files = {
    'server/src/x.ts': `const skip = '${folder}';\n`,
    'server/src/x.spec.ts': `const skip = '${folder}';\n`,
    'dashboard/src/y.tsx': 'const node = event.target;\n',
  };
  const root = makeRoot(files);

  const violations = findViolations({ root, rules, files: Object.keys(files) });

  assert.equal(violations.length, 1);
  assert.match(violations[0], /^server\/src\/x\.ts:1:/);
});

test('reports a path in AGENTS.md that does not exist and is not ignored', () => {
  const root = makeRoot({ 'AGENTS.md': 'Rules.\nSee `src/gone/` and `gone.md`.\n' });

  const violations = findViolations({ root, rules, files: [], isIgnored: () => false });

  assert.deepEqual(violations, ['AGENTS.md:2: src/gone/', 'AGENTS.md:2: gone.md']);
});

test('accepts an existing path, an ignored path, a glob and a plain word in AGENTS.md', () => {
  const root = makeRoot({
    'AGENTS.md': 'Use `src/there.ts`, `local/`, `*.spec-helpers.ts`, `if (a/b)` and `Clock`.\n',
    'src/there.ts': '',
  });

  const violations = findViolations({ root, rules, files: [], isIgnored: (path) => path === 'local/' });

  assert.deepEqual(violations, []);
});

test('asks git whether a missing path in AGENTS.md is ignored', () => {
  const root = makeRoot({ 'AGENTS.md': 'Keep `.gitignore` and `local/` out.\n', '.gitignore': 'local/\n' });
  execFileSync('git', ['init', '-q'], { cwd: root });

  assert.deepEqual(findViolations({ root, rules, files: [] }), []);
});

test('forbidOutside reports a host name in the login page and lets the host map keep it', () => {
  const line = `const host = '${['Git', 'Hub'].join('')}';\n`;
  const files = { 'dashboard/app/login/page.tsx': line, 'dashboard/app/login/hosts.tsx': line };
  const root = makeRoot(files);

  const violations = findViolations({ root, rules, files: Object.keys(files) });

  assert.equal(violations.length, 1);
  assert.match(violations[0], /^dashboard\/app\/login\/page\.tsx:1:/);
});

test('forbidOutside reports a host name in the server outside the places that may keep it', () => {
  const line = `const host = '${['git', 'lab'].join('')}';\n`;
  const allowed = [
    'server/src/integrations/code-host/some-host/index.ts',
    'server/src/config/env.schema.ts',
    'server/src/history/migrations/1-x.ts',
    'server/src/testing/x.ts',
    'server/src/steps/x/x.spec.ts',
    'server/src/steps/x/x.spec-helpers.ts',
  ];

  const violations = check({ 'server/src/steps/x/x.step.ts': line });

  assert.equal(violations.length, 1);
  assert.match(violations[0], /^server\/src\/steps\/x\/x\.step\.ts:1:/);
  for (const file of allowed) {
    assert.deepEqual(check({ [file]: line }), [], file);
  }
  assert.equal(check({ 'server/src/steps/x/x.step.ts': `// ${['BIT', 'BUCKET'].join('')}\n` }).length, 1);
});

function check(files) {
  return findViolations({ root: makeRoot(files), rules, files: Object.keys(files) });
}

test('agent answer rules report a section( call on an answer in steps/', () => {
  const violations = check({ 'server/src/steps/x/x.step.ts': "const body = section(answer, 'plan');\n" });

  assert.equal(violations.length, 1);
  assert.match(violations[0], /^server\/src\/steps\/x\/x\.step\.ts:1:/);
});

test('agent answer rules report each prose read in its directory', () => {
  const cases = {
    'server/src/steps/x/a.ts': 'const text = run.agentResult.responseText;\n',
    'server/src/pipeline/b.ts': "const raw = stepOutput(root, key, 'plan', attempt);\n",
    'server/src/api/c.ts': 'const list = items(body);\n',
    'server/src/api/d.ts': "const cells = line.split('|');\n",
    'server/src/steps/x/e.ts': 'const label = /^questions:/m.exec(body);\n',
    'server/src/steps/x/f.ts': "const text = 'End with these sections: plan, summary.';\n",
    'server/src/steps/x/g.ts': "const text = 'Finish with a line decision: ok or return.';\n",
  };

  for (const [file, text] of Object.entries(cases)) {
    const violations = check({ [file]: text });
    assert.equal(violations.length, 1, file);
    assert.match(violations[0], new RegExp(`^${file.replaceAll('.', '\\.')}:1:`));
  }
});

test('agent answer rules report a label regex whatever the variable is called', () => {
  const cases = {
    'server/src/steps/commit/commit-delivered.ts':
      'const MET = /^\\W*(?:\\d+\\.\\s*)?met:\\s*.*\\(([^()]+)\\)\\s*$/gim;\n',
    'server/src/steps/x/decision.ts': 'const result = /^decision:\\s*(ok|return)/m.exec(answer);\n',
    'server/src/pipeline/job.ts': 'const job = /^job:\\s*(.+)$/m.exec(body)?.[1];\n',
  };

  for (const [file, text] of Object.entries(cases)) {
    const violations = check({ [file]: text });
    assert.equal(violations.length, 1, file);
    assert.match(violations[0], new RegExp(`^${file.replaceAll('.', '\\.')}:1:`));
  }
});

test('agent answer rules let the registry read the labels of its own pipeline_log document', () => {
  const text =
    "const result = /^result:\\s*(\\S+)/m.exec(body)?.[1] ?? '';\nconst job = /^job:\\s*(.+)$/m.exec(body)?.[1];\n";

  assert.deepEqual(check({ 'server/src/steps/contract/artifact-summaries.ts': text }), []);
  assert.equal(check({ 'server/src/steps/contract/artifact-summary.ts': text }).length, 2);
});

test('agent answer rules let the allowed files keep the same lines', () => {
  const cases = {
    'server/src/steps/shared/agent-launcher.ts': 'const text = result.responseText;\n',
    'server/src/steps/shared/model-visit.ts': 'const text = agent.responseText;\n',
    'server/src/steps/shared/answers.ts': 'const label = /^answer:/m.exec(body);\nconst list = items(body);\n',
  };

  for (const [file, text] of Object.entries(cases)) {
    assert.deepEqual(check({ [file]: text }), [], file);
  }
});

test('agent answer rules skip spec files and files outside the three directories', () => {
  assert.deepEqual(
    check({
      'server/src/steps/x/x.step.spec.ts': "const body = section(answer, 'plan');\n",
      'server/src/steps/x/x.spec-helpers.ts': 'const text = run.responseText;\n',
      'server/src/agent-result/read.ts': "const raw = stepOutput(root, key, 'plan', attempt);\n",
      'server/src/contract/readable-log.ts': 'const list = items(body);\n',
    }),
    [],
  );
});

test('agent answer rules do not match helper names or an object key that only look alike', () => {
  assert.deepEqual(
    check({
      'server/src/steps/x/x.step.ts':
        "const view = withSections(items.map(sectionOf));\nconst record = { decision: 'ok' };\nconst text = 'decision: ok when it is fixed.';\n",
    }),
    [],
  );
});

test('a forbidOutside include may be a list of prefixes', () => {
  const listRules = { ...rules, forbidOutside: [{ include: ['a/', 'b/'], pattern: 'bad' }] };
  const files = { 'a/x.ts': 'bad\n', 'b/y.ts': 'bad\n', 'c/z.ts': 'bad\n' };
  const root = makeRoot(files);

  const violations = findViolations({ root, rules: listRules, files: Object.keys(files) });

  assert.deepEqual(violations, ['a/x.ts:1: bad', 'b/y.ts:1: bad']);
});

test('the dashboard rule reports a decision read out of a log and lets a stored decision field be read', () => {
  const violations = check({
    'dashboard/features/run/live-chip.ts': 'const decision = /^decision: (ok|return)/m.exec(log);\n',
  });
  assert.equal(violations.length, 1);
  assert.match(violations[0], /^dashboard\/features\/run\/live-chip\.ts:1:/);

  assert.deepEqual(check({ 'dashboard/features/run/chip.ts': "const ok = visit.decision === 'decision: ok';\n" }), []);
  assert.deepEqual(check({ 'dashboard/features/run/chip.test.ts': 'const line = log.match(/^decision: ok/m);\n' }), []);
});

test('forbidOutside reports a second state-to-icon table in the dashboard and lets run-state-word keep its own', () => {
  const table = ['const LOOK: Record<Subtask', 'Status, typeof Play', 'Icon> = {};\n'].join('');
  const files = {
    'dashboard/features/run/flow/run-screen/task-look.ts': table,
    'dashboard/features/run/run-state-word.tsx': table,
    'dashboard/features/run/flow/run-screen/counts.ts': 'const n: Partial<Record<SubtaskStatus, number>> = {};\n',
  };
  const root = makeRoot(files);

  const violations = findViolations({ root, rules, files: Object.keys(files) });

  assert.equal(violations.length, 1);
  assert.match(violations[0], /^dashboard\/features\/run\/flow\/run-screen\/task-look\.ts:1:/);
});

test('only the naming module builds branch names, commit messages and titles', () => {
  const text =
    'const branch = `feature/${key}`;\nconst message = `feat(${key}): ${summary}`;\nrenderTemplate(format, values);\n';

  assert.equal(check({ 'server/src/steps/commit/commit.step.ts': text }).length, 3);
  assert.deepEqual(check({ 'server/src/git/naming/git-names.ts': text }), []);
  assert.deepEqual(check({ 'server/src/steps/commit/commit.step.spec.ts': text }), []);
  assert.deepEqual(check({ 'server/src/testing/flow-harness.ts': text }), []);
});

test('forbidOutside reports a resume accepted or a run started outside the start gate, and lets the gate, a route and a spec be', () => {
  const files = {
    'server/src/pipeline/subtask-port.ts': "await this.commands.accept('resume', run.key, {}, { idempotencyKey });\n",
    'server/src/pipeline/reconciler-resumes.ts': 'await this.pipeline.startDetached(run.key);\n',
    'server/src/pipeline/start-gate.ts': "await this.commands.accept('resume', run.key, payload, options);\n",
    'server/src/api/run-commands.service.ts':
      "await this.commands.submit('resume', key, payload);\nthis.pipeline.startDetached(key);\n",
    'server/src/pipeline/subtask-port.spec.ts':
      "expect(accept).toHaveBeenCalledWith('resume', 'child');\nport.startDetached(key);\n",
    'server/src/pipeline/subtask-rebases.ts': "await this.commands.accept('rebase', run.key, {});\n",
  };
  const root = makeRoot(files);

  const violations = findViolations({ root, rules, files: Object.keys(files) });

  assert.equal(violations.length, 2);
  assert.match(violations[0], /^server\/src\/pipeline\/subtask-port\.ts:1:/);
  assert.match(violations[1], /^server\/src\/pipeline\/reconciler-resumes\.ts:1:/);
});

test('forbidOutside reports a command type passed in a variable outside the start gate, and lets the planner own turn be', () => {
  const text = 'await this.commands.submit(act.command, key, payload, options);\n';

  assert.equal(check({ 'server/src/pipeline/reconciler-resumes.ts': text }).length, 1);
  assert.deepEqual(check({ 'server/src/pipeline/planner-own-turn.ts': text }), []);
  assert.deepEqual(check({ 'server/src/pipeline/reconciler-resumes.spec.ts': text }), []);
});

test('only subtask-rebases sends a part its move as its parent', () => {
  const text = 'await this.rebase(part, { byParent: true });\n';

  assert.equal(check({ 'server/src/pipeline/run-driver.ts': text }).length, 1);
  assert.deepEqual(check({ 'server/src/pipeline/subtask-rebases.ts': text }), []);
  assert.deepEqual(check({ 'server/src/pipeline/subtask-rebases.spec.ts': text }), []);
});

test('only the epic main door decides which epic takes main', () => {
  const text = 'const takes = await this.rebaser.takesMain(epic);\n';

  assert.equal(check({ 'server/src/steps/checks/checks.step.ts': text }).length, 1);
  for (const door of [
    'server/src/steps/shared/epic-between-passes.ts',
    'server/src/steps/run-rebase.ts',
    'server/src/pipeline/backlog/epic-main-moves.ts',
    'server/src/steps/run-rebase.spec.ts',
  ]) {
    assert.deepEqual(check({ [door]: text }), [], door);
  }
});

test('a code host is reached only through the door of the run person', () => {
  const byName = 'const host = (await this.hosts.forRun(run.startedBy)).byName(run.codeHost);\n';
  const token = 'const scoped = host.withToken(token);\n';

  assert.equal(check({ 'server/src/steps/implement/split-merge.ts': byName }).length, 1);
  assert.equal(check({ 'server/src/pipeline/run-driver.ts': token }).length, 1);
  for (const allowed of [
    'server/src/integrations/code-host/code-host.registry.ts',
    'server/src/steps/prepare/remote-repositories.service.ts',
    'server/src/steps/shared/repository-host.ts',
    'server/src/steps/shared/rebased-publisher.ts',
    'server/src/readiness/readiness.service.ts',
    'server/src/testing/flow-harness.ts',
    'server/src/steps/implement/split-rebase.spec.ts',
  ]) {
    assert.deepEqual(check({ [allowed]: byName + token }), [], allowed);
  }
  assert.deepEqual(check({ 'server/src/steps/shared/call-context.ts': 'await this.starts.forRun(run.id);\n' }), []);
});

test('only the own-change files say what a move carries', () => {
  const onto = "await git(['-C', path, 'rebase', '--onto', base, old]);\n";
  const mergeBase = "await git(['merge-base', 'HEAD', tip]);\n";

  assert.equal(check({ 'server/src/pipeline/run-driver.ts': onto }).length, 1);
  assert.equal(check({ 'server/src/pipeline/run-driver.ts': mergeBase }).length, 1);
  for (const door of [
    'server/src/git/rebase/own-change.ts',
    'server/src/pipeline/parent-tree-sync.ts',
    'server/src/pipeline/subtask-worktrees.ts',
    'server/src/pipeline/parent-tree-sync.spec.ts',
  ]) {
    assert.deepEqual(check({ [door]: onto + mergeBase }), [], door);
  }
});

test('only start-waits records the wait of an agent start', () => {
  const text = 'await this.facts.recordStartWait(run, wait);\n';

  assert.equal(check({ 'server/src/steps/implement/implement.step.ts': text }).length, 1);
  assert.deepEqual(check({ 'server/src/steps/shared/start-waits.ts': text }), []);
  assert.deepEqual(check({ 'server/src/steps/shared/start-waits.spec.ts': text }), []);
});

test('only history writes a run row', () => {
  const text = '@InjectRepository(RunEntity) private readonly runs: Repository<RunEntity>;\n';

  assert.equal(check({ 'server/src/pipeline/run-writer.ts': text }).length, 1);
  assert.equal(check({ 'server/src/pipeline/run-writer.ts': 'await runs.saveRun(run);\n' }).length, 1);
  assert.deepEqual(check({ 'server/src/history/run.repository.ts': text }), []);
  assert.deepEqual(check({ 'server/src/pipeline/run-writer.spec.ts': text }), []);
});

test('forbidOutside reports an outside-wait test outside the table and lets model-host-unavailable.ts and a spec keep it', () => {
  const lines = [
    'if (!(error instanceof ModelHostUnavailable)) {',
    'if (error instanceof HostUnavailable) throw error;',
    'if (error instanceof RuntimeLimit) return null;',
  ];
  const files = {
    'server/src/pipeline/x.ts': lines.join('\n') + '\n',
    'server/src/steps/shared/model-host-unavailable.ts': lines[0] + '\n',
    'server/src/pipeline/x.spec.ts': lines.join('\n') + '\n',
  };
  const root = makeRoot(files);

  const violations = findViolations({ root, rules, files: Object.keys(files) });

  assert.equal(violations.length, 3);
  for (const line of violations) assert.match(line, /^server\/src\/pipeline\/x\.ts:\d:/);
});
