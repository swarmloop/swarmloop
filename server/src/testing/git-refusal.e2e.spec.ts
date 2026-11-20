import 'reflect-metadata';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { actionsFor, NEEDS_PERSON, stateWord } from '../contract/run-state';
import { ERROR_CODES } from '../contract/error-codes';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { deriveState } from '../history/run-state';
import { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import { installOriginHook, type FakeHostSettings, type FakeOriginRules } from './fake-host-rules';
import { createFlowHarness } from './flow-harness';
import { git } from './git-fixture';
import { resultAnswer } from './result-answer';
import type { FakeAgentRunner } from './test-app';
import type { AgentRunInput } from '../agent/agent-runner';
import { result } from '../steps/plan/plan.step.spec-helpers';

const KEY = 'PROJ-630';
const FEATURE = `feature/${KEY}-ship-the-field`;
const FILE = '.swarmloop.json';
const COMMIT_RULE = { pattern: '^[a-z]+: ', message: 'commit message must be conventional' };
const TITLE_RULE = { pattern: '^[a-z]+: ', message: 'title must be conventional' };
const BRANCH_RULE = { pattern: '^work/', message: 'branch name must start with work/' };

const SUBTASKS = JSON.stringify([
  {
    id: 'T1',
    title: 'Task',
    description: 'Do it.',
    depends: [],
    files: ['src/a.ts'],
    proof: 'a.spec.ts',
    status: 'waiting',
  },
]);

/** The answer of the implement agent to a refusal: the change again, and the rule the host's message names. */
const answerWith = (gitRules: Record<string, string>) => ({
  change: { type: 'feat', subject: 'Ship the field' },
  gitRules,
});

/** The implement agent asked in a chat of its own: each question is answered from the queue, and kept. */
class RefusalAgent implements FakeAgentRunner {
  readonly steps: string[] = [];
  readonly prompts: string[] = [];

  constructor(private readonly answers: unknown[]) {}

  run(step: string, input: AgentRunInput): Promise<unknown> {
    this.steps.push(step);
    if (step !== 'merge-request') return Promise.resolve(undefined);
    this.prompts.push(input.prompt);
    return Promise.resolve(result(resultAnswer('Answered.', this.answers.shift())));
  }
}

/** A host that refuses a name once is answered once; refused again, a person adds the rule to the repository. */
describe('a host refusal of a name', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let agent: RefusalAgent;

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  async function start(
    fakeHost: FakeHostSettings,
    origin: FakeOriginRules = {},
    answers: ReturnType<typeof answerWith>[],
    step: 'plan' | 'merge-request' = 'plan',
    repoFiles?: Record<string, string>,
  ): Promise<void> {
    agent = new RefusalAgent(answers);
    flow = await createFlowHarness(KEY, {
      realHost: true,
      realSteps: ['branch', 'commit'],
      fakeHost,
      runner: agent,
      ...(repoFiles ? { repoFiles } : {}),
    });
    // The host's own hook lets the feature branch through, as its merges do; here the work of the run is what it checks.
    if (origin.branch || origin.commit) installOriginHook(join(flow.app.root, 'demo.git'), 'main', origin);
    const run = await flow.begin(step);
    await flow.app.app.get(RunRepository).saveRun({ ...run, startedBy: null });
    const registry = flow.app.app.get(CodeHostRegistry);
    jest.spyOn(registry, 'forRun').mockResolvedValue(registry);
    jest.spyOn(registry, 'requiredCredentials').mockReturnValue(flow.host.selected());
  }

  /** The branch is new on the host: the harness pushed it before the hook was there. */
  async function removeFeatureFromOrigin(): Promise<void> {
    git(join(flow.app.root, 'demo.git'), ['branch', '-D', FEATURE]);
    git(flow.tree, ['update-ref', '-d', `refs/remotes/origin/${FEATURE}`]);
  }

  const written = (): unknown => JSON.parse(readFileSync(join(flow.tree, FILE), 'utf8'));
  const asked = (): number => agent.prompts.length;

  async function commitOne(): Promise<void> {
    await flow.app.pipeline.step('branch', KEY);
    mkdirSync(join(flow.tree, 'src'), { recursive: true });
    writeFileSync(join(flow.tree, 'src', 'field.ts'), 'export const field = 1;\n');
    await flow.app.pipeline.step('commit', KEY);
  }

  it('answers a refused commit message once, amends it, and keeps the rule with the work', async () => {
    await start({}, { commit: COMMIT_RULE }, [answerWith({ commit: '{type}: {subject}' })]);
    await commitOne();
    expect(asked()).toBe(1);
    expect(git(flow.tree, ['log', '-1', '--format=%s'])).toBe('feat: Ship the field');
    expect(git(flow.tree, ['show', '--name-only', '--format=', 'HEAD'])).toContain(FILE);
    expect(git(flow.tree, ['rev-parse', 'HEAD'])).toBe(git(flow.tree, ['rev-parse', `refs/remotes/origin/${FEATURE}`]));
    expect(written()).toEqual({ version: 1, git: { commit: '{type}: {subject}' } });
  });

  it('answers a refused title once and opens the request with the title of the rule', async () => {
    await start({ title: TITLE_RULE }, {}, [answerWith({ title: '{type}: {subject}' })], 'merge-request');
    await flow.app.pipeline.step('merge-request', KEY);
    expect(asked()).toBe(1);
    expect(flow.host.openAsks).toBe(2);
    expect(flow.host.opened).toBe(1);
    expect(written()).toEqual({ version: 1, git: { title: '{type}: {subject}' } });
  });

  it('blocks with the rule error, Resume and its word when the commit is refused twice, and Resume renders it again', async () => {
    await start({}, { commit: COMMIT_RULE }, [answerWith({})]);
    await commitOne();
    const run = (await flow.app.app.get(RunRepository).findRun(KEY))!;
    const { state, reason } = deriveState(run);
    expect(state).toBe('blocked');
    expect(reason?.code).toBe(ERROR_CODES.GIT_RULES);
    expect(reason?.message).toMatch(
      /^! \[remote rejected\].*\(pre-receive hook declined\) refuses feat\(PROJ-630\): Ship the field\. put the rule into \.swarmloop\.json$/,
    );
    expect(actionsFor(state, reason?.code ?? null)).toContain(NEEDS_PERSON[ERROR_CODES.GIT_RULES]);
    expect(stateWord(state, reason, {}, (iso) => iso).word).toBe('Waits for you: a git rule of the repository');
    expect(asked()).toBe(1);

    writeFileSync(join(flow.tree, FILE), JSON.stringify({ version: 1, git: { commit: '{type}: {subject}' } }));
    await flow.app.pipeline.step('commit', KEY);
    expect(asked()).toBe(1);
    expect(git(flow.tree, ['log', '-1', '--format=%s'])).toBe('feat: Ship the field');
    expect(git(flow.tree, ['rev-parse', 'HEAD'])).toBe(git(flow.tree, ['rev-parse', `refs/remotes/origin/${FEATURE}`]));
  });

  it('passes the next run with the rule already in the repository and asks nothing', async () => {
    const rule = { version: 1, git: { commit: '{type}: {subject}' } };
    await start({}, { commit: COMMIT_RULE }, [], 'plan', { [FILE]: JSON.stringify(rule) });
    await commitOne();
    expect(asked()).toBe(0);
    expect(git(flow.tree, ['log', '-1', '--format=%s'])).toBe('feat: Ship the field');
    expect(git(flow.tree, ['rev-parse', 'HEAD'])).toBe(git(flow.tree, ['rev-parse', `refs/remotes/origin/${FEATURE}`]));
  });

  it('renames a refused branch on the first push of a run that is not split, and keeps the rule', async () => {
    await start({}, { branch: BRANCH_RULE }, [answerWith({ branch: 'work/{slug}' })]);
    await removeFeatureFromOrigin();
    await commitOne();
    expect(asked()).toBe(1);
    expect(git(flow.tree, ['branch', '--show-current'])).toBe('work/ship-the-field');
    expect(git(join(flow.app.root, 'demo.git'), ['branch', '--list', 'work/*']).trim()).toBe('work/ship-the-field');
    expect(written()).toEqual({ version: 1, git: { branch: 'work/{slug}' } });
  });

  it('renders a refused branch again on Resume once the person has put the rule into the repository', async () => {
    await start({}, { branch: BRANCH_RULE }, [answerWith({})]);
    await removeFeatureFromOrigin();
    await commitOne();
    const run = (await flow.app.app.get(RunRepository).findRun(KEY))!;
    expect(deriveState(run).reason?.code).toBe(ERROR_CODES.GIT_RULES);
    writeFileSync(join(flow.tree, FILE), JSON.stringify({ version: 1, git: { branch: 'work/{slug}' } }));
    await flow.app.pipeline.step('commit', KEY);
    expect(asked()).toBe(1);
    expect(git(flow.tree, ['branch', '--show-current'])).toBe('work/ship-the-field');
    expect(git(join(flow.app.root, 'demo.git'), ['branch', '--list', 'work/*']).trim()).toBe('work/ship-the-field');
  });

  it('renames a refused branch of a split run in the repository and pushes it under the new name', async () => {
    await start({}, { branch: BRANCH_RULE }, [answerWith({ branch: 'work/{slug}' })]);
    const run = (await flow.app.app.get(RunRepository).findRun(KEY))!;
    run.split = true;
    await flow.app.app.get(RunRepository).saveRun(run);
    await flow.app.app.get(DocumentRepository).putDocument(run, 'subtasks', SUBTASKS);
    git(join(flow.app.root, 'demo.git'), ['branch', '-D', `feature/${KEY}-ship-the-field`]);
    await flow.app.pipeline.step('branch', KEY);
    expect(asked()).toBe(1);
    expect(git(flow.tree, ['branch', '--show-current'])).toBe('work/ship-the-field');
    expect(git(join(flow.app.root, 'demo.git'), ['branch', '--list', 'work/*']).trim()).toBe('work/ship-the-field');
  });
});
