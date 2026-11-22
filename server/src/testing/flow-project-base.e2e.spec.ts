import 'reflect-metadata';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { ERROR_CODES } from '../contract/error-codes';
import { checkRun, fromSwarmloop } from '../environment/environment-config';
import { EnvironmentService } from '../environment/environment.service';
import { DocumentRepository } from '../history/document.repository';
import { storedState } from '../history/run-state';
import { RunRepository } from '../history/run.repository';
import { BlockAgentRunner } from './result-answer';
import { createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { git, remember } from './runs.spec-helpers';

const KEY = 'PROJ-460';
const LATER = 'PROJ-461';
const FEATURE = `feature/${KEY}-ship-the-field`;
const MINUTE = 60_000;
const CHECKS = ['npm run format:check', 'npm run lint', 'npm run typecheck', 'npm test'];

describe('a new repository gets its base, CI runs, and a later run gets the manifest environment', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let blocks: BlockAgentRunner;

  beforeEach(async () => {
    blocks = new BlockAgentRunner({
      plan: [
        {
          block: {
            summary: ['the repository has no CI, so its base comes first'],
            plan: [
              'base: the project base - files: .swarmloop.json, .gitlab-ci.yml, AGENTS.md - proof: CI runs the checks',
              'ship the field - files: src/field.ts - proof: the field test',
            ],
          },
        },
      ],
    });
    flow = await createFlowHarness(KEY, { realHost: true, blocks });
    flow.fastWaits();
    flow.host.runsWithWorkflow();
    git(flow.tree, ['rm', '-r', '-q', 'src']);
    writeFileSync(join(flow.tree, 'README.md'), '# demo\n');
    git(flow.tree, ['add', 'README.md']);
    git(flow.tree, ['commit', '-m', 'Initial commit']);
    git(flow.tree, ['push', 'origin', FEATURE]);
    git(flow.tree, ['push', 'origin', 'HEAD:main']);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const documents = () => flow.app.app.get(DocumentRepository);
  const show = (file: string) => git(flow.tree, ['show', `HEAD:${file}`]);

  /** Ticks until the fake clock is `minutes` ahead; the invariants hold after every tick. Returns the reason codes seen. */
  async function tickFor(minutes: number): Promise<(string | undefined)[]> {
    const codes: (string | undefined)[] = [];
    const until = flow.app.clock.now() + minutes * MINUTE;
    while (flow.app.clock.now() < until) {
      await flow.tick();
      await flow.app.pipeline.whenIdle(KEY);
      await assertInvariants(flow.app);
      const run = (await flow.app.app.get(RunRepository).findRun(KEY))!;
      codes.push(storedState(run).reason?.code);
    }
    return codes;
  }

  it('plans the base first, commits it with its CI, passes the pipeline, and gives a later run the environment', async () => {
    expect(git(flow.tree, ['ls-tree', '--name-only', 'HEAD'])).toBe('README.md');
    const readmeSha = git(flow.tree, ['rev-parse', 'HEAD']);

    await flow.begin('plan');
    await flow.app.pipeline.step('plan', KEY);
    await flow.app.pipeline.whenIdle(KEY);
    const planPrompt = blocks.prompts.filter((entry) => entry.step === 'plan').at(-1)?.prompt;
    expect(planPrompt).toContain('/work/brief/skills/implement/project-base.md');
    const plan = (await documents().latestBody(KEY, 'plan_result')) ?? '';
    expect(plan.indexOf('base: the project base')).toBeGreaterThanOrEqual(0);
    expect(plan.indexOf('base: the project base')).toBeLessThan(plan.indexOf('ship the field'));

    const manifest = { version: 1, image: 'node:22', setup: 'npm ci', cache: ['/home/sandbox/.npm'], checks: CHECKS };
    writeFileSync(join(flow.tree, '.swarmloop.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(
      join(flow.tree, '.gitlab-ci.yml'),
      `check:\n  script:\n${CHECKS.map((command) => `    - ${command}`).join('\n')}\n`,
    );
    writeFileSync(join(flow.tree, 'AGENTS.md'), '# rules\n\n- the smallest change that does the task\n');
    git(flow.tree, ['add', '.swarmloop.json', '.gitlab-ci.yml', 'AGENTS.md']);
    git(flow.tree, ['commit', '-m', 'chore: project base']);
    git(flow.tree, ['push', 'origin', FEATURE]);
    for (const file of ['.swarmloop.json', '.gitlab-ci.yml', 'AGENTS.md']) expect(show(file)).not.toBe('');
    const script = show('.gitlab-ci.yml')
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.startsWith('- '))
      .map((line) => line.slice(2));
    expect(fromSwarmloop(show('.swarmloop.json')).checks.map(checkRun)).toEqual(script);

    await flow.begin('merge-request');
    await flow.app.pipeline.step('merge-request', KEY);
    await flow.app.pipeline.whenIdle(KEY);
    await flow.app.pipeline.runThrough(KEY);
    const codes = await tickFor(62);
    expect(codes).not.toContain(ERROR_CODES.CI_NOT_RUN);
    expect(flow.host.nudged).toEqual([]);
    const run = (await flow.app.app.get(RunRepository).findRun(KEY))!;
    expect(storedState(run).state).toBe('done');
    expect(await documents().latestBody(KEY, 'pipeline_log')).toContain('result: pass');
    expect(flow.host.ci.snapshot(readmeSha, FEATURE)).toBeNull();

    const clone = join(flow.app.root, 'demo');
    git(clone, ['remote', 'set-url', 'origin', join(flow.app.root, 'demo.git')]);
    await flow.host.mergeMergeRequest('group/demo', 1);
    git(clone, ['fetch', 'origin']);
    const laterTree = join(flow.app.root, 'worktrees', LATER, 'demo');
    git(clone, ['worktree', 'add', '-b', `feature/${LATER}-next`, laterTree, `origin/${FEATURE}`]);
    const later = await remember(flow.app.app.get(RunRepository), documents(), LATER, 'implement', 'waiting');
    const commands = await flow.app.app
      .get(EnvironmentService)
      .checkCommands({ run: later, key: LATER, mounts: [{ hostPath: laterTree, containerPath: '/work/demo' }] });
    expect(commands.map((entry) => entry.command)).toEqual(CHECKS);
    const stored = JSON.parse((await documents().latestBody(LATER, 'environment:demo')) ?? 'null') as {
      config: { image: string; checks: string[] };
    } | null;
    expect(stored?.config.image).toBe('node:22');
    expect(stored?.config.checks.map(checkRun)).toEqual(CHECKS);
  });
});
