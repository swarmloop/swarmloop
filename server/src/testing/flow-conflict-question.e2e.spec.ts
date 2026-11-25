import 'reflect-metadata';
import { storeRun } from './store-run.spec-helpers';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { isAbsolute, join } from 'path';
import { BacklogChatService } from '../api/backlog-chat.service';
import { REASON } from '../contract/run-state';
import { BacklogRepository } from '../history/backlog.repository';
import { PlanChatStore } from '../history/plan-chat.store';
import { RunRepository } from '../history/run.repository';
import { storedState } from '../history/run-state';
import { BacklogPlanner } from '../pipeline/backlog/planner/backlog-planner';
import { CommandService } from '../pipeline/command.service';
import { RunRebase } from '../steps/run-rebase';
import { agentStateDir } from '../sandbox/sandbox-launch';
import { sessionFileName, sessionHome } from '../history/session-group';
import { SubtaskPort } from '../pipeline/subtask-port';
import { DocumentRepository } from '../history/document.repository';
import { FAKE_MODEL_KEY } from './env.spec-helpers';
import { ConflictAgent, createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { git, remember } from './runs.spec-helpers';

const KEY = 'PROJ-490';
const FEATURE = `feature/${KEY}-ship-the-field`;
const ANSWER = 'Keep the version of main.';
const ESCALATION = 'The planner of the run cannot choose a side of src/readme.ts.';
const OWN = ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com'];

describe('a conflict that the agent leaves open is a question up the planners', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let agent: ConflictAgent;
  let tip: string;
  /** The agent never resolves the files, answer or not. */
  let stubborn = false;

  /** The agent gives the merge up until the planner's answer reaches its prompt, then resolves the file as main has it. */
  async function boot(planner: { escalate?: string } = {}): Promise<void> {
    agent = new ConflictAgent(
      (prompt) => {
        if (!stubborn && prompt.includes(ANSWER))
          return writeFileSync(join(flow.tree, 'src', 'readme.ts'), 'export const readme = 3;\n');
        const state = git(flow.tree, ['rev-parse', '--git-path', 'swarmloop-rebase']);
        rmSync(isAbsolute(state) ? state : join(flow.tree, state), { force: true });
        git(flow.tree, ['reset', '--hard', tip]);
      },
      { plan: [{ block: { reply: planner.escalate ? 'Passing it on.' : ANSWER, ...planner } }] },
    );
    flow = await createFlowHarness(KEY, {
      env: { CHECKOUTS_ROOT: '.', ...FAKE_MODEL_KEY },
      blocks: agent,
    });
    const bare = join(flow.app.root, 'demo.git');
    git(join(flow.app.root, 'demo'), ['remote', 'set-url', 'origin', `file://${bare}`]);
    flow.host.defaultBranchIs('main');
    flow.host.defaultBranchPasses();
  }

  beforeEach(() => {
    stubborn = false;
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.app.app.get(CommandService).idle();
    await flow.close();
  });

  const get = <T>(token: new (...args: never[]) => T): T => flow.app.app.get(token);
  const questions = async () =>
    (await get(PlanChatStore).read(KEY)).entries.filter((entry) => entry.kind === 'question');
  const stored = async () => storedState((await get(RunRepository).findRun(KEY))!);

  function commit(tree: string, text: string): void {
    writeFileSync(join(tree, 'src', 'readme.ts'), text);
    git(tree, ['add', 'src/readme.ts']);
    git(tree, [...OWN, 'commit', '-m', 'feat: readme']);
  }

  /** The run's own commit conflicts with main, and a person's Rebase parks the rebase and sends the run to implement. */
  async function parked(): Promise<void> {
    const runs = get(RunRepository);
    const run = await remember(runs, get(DocumentRepository), KEY, 'implement', 'idle');
    run.codeHost = 'gitlab';
    await storeRun(runs, run);
    await get(DocumentRepository).putDocument(run, 'implementation', '- the field\n');
    await get(DocumentRepository).putDocument(
      run,
      'requirements',
      `${JSON.stringify({
        prompt: 'Ship the field\n',
        tickets: [{ key: KEY, summary: 'Ship the field' }],
        plan: { name: 'plan', overview: '', items: ['do it'], decision: 'approve' },
      })}\n`,
    );
    // The run's planner has a chat to answer in, as a run that planned has.
    mkdirSync(agentStateDir(flow.app.root, KEY, sessionHome('plan')), { recursive: true });
    writeFileSync(
      join(flow.app.root, 'data', sessionFileName(KEY, 'plan')),
      `${JSON.stringify({ runtime: 'claude', chatId: 'plan-chat', resumed: true, completed: true, killReason: null })}\n`,
    );
    commit(flow.tree, 'export const readme = 2;\n');
    tip = git(flow.tree, ['rev-parse', 'HEAD']);
    git(flow.tree, ['push', 'origin', FEATURE]);
    const bare = join(flow.app.root, 'demo.git');
    const other = join(flow.app.root, 'main-clone');
    git(flow.app.root, ['clone', '--branch', 'main', bare, other]);
    commit(other, 'export const readme = 4;\n');
    git(other, ['push', 'origin', 'main']);
    expect(await get(RunRebase).rebase(KEY)).toBe('resolve');
    expect(await get(DocumentRepository).latestBody(KEY, 'rebase_conflict')).toMatch(/^pending-implement/);
  }

  it('asks the run’s planner with the repository and the files, and the answer starts implement again', async () => {
    await boot();
    await parked();
    const rebased = jest.spyOn(get(SubtaskPort), 'rebase');

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    const [asked] = await questions();
    expect(asked?.text).toContain('demo still conflicts in src/readme.ts');
    expect(asked?.state).toBe('taken');
    const plannerTurn = agent.prompts.find((launch) => launch.step === 'plan');
    expect(plannerTurn?.prompt).toContain('demo still conflicts in src/readme.ts');
    expect(agent.conflicts).toHaveLength(2);
    expect(agent.conflicts[0]).not.toContain(ANSWER);
    expect(agent.conflicts[1]).toContain(ANSWER);
    expect(['blocked', 'failed']).not.toContain((await stored()).state);
    expect(rebased).not.toHaveBeenCalled();
    expect(readFileSync(join(flow.tree, 'src', 'readme.ts'), 'utf8')).toBe('export const readme = 3;\n');
    await assertInvariants(flow.app);
  });

  it('holds a start on the same input: the agent gives up again, the same question is refused and goes one level up', async () => {
    await boot();
    await parked();
    stubborn = true;
    const levels: number[] = [];
    const reasons: (string | undefined)[] = [];
    const port = get(SubtaskPort);
    const askUp = port.askUp.bind(port);
    jest.spyOn(port, 'askUp').mockImplementation(async (asking, question, level) => {
      levels.push(level ?? 0);
      reasons.push(storedState((await get(RunRepository).findRun(asking.key))!).reason?.code);
      return askUp(asking, question, level);
    });

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    expect(agent.conflicts.length).toBeGreaterThanOrEqual(2);
    expect(levels).toEqual([1]);
    expect(reasons).toEqual([REASON.sameInput]);
    expect(['blocked', 'failed']).not.toContain((await stored()).state);
    await assertInvariants(flow.app);
  });

  it('asks the backlog planner for a task of a backlog', async () => {
    await boot({ escalate: ESCALATION });
    await parked();
    const backlogs = get(BacklogRepository);
    flow.backlog();
    const at = new Date(flow.app.clock.now()).toISOString();
    const backlog = await backlogs.saveBacklog({
      name: 'shop',
      owner: 'ada',
      repositories: ['demo'],
      mergeMode: 'green',
      paused: false,
      createdAt: at,
    });
    const milestone = await backlogs.saveMilestone({
      backlogId: backlog.id as number,
      number: 1,
      title: 'M1',
      goal: '',
      status: 'active',
      createdAt: at,
    });
    await backlogs.saveTask({
      backlogId: backlog.id as number,
      milestoneId: milestone.id as number,
      slug: 'field',
      title: 'The field',
      description: 'Ship the field',
      repositories: ['demo'],
      covers: [],
      depends: [],
      files: [],
      proof: [],
      manual: false,
      fixesMain: null,
      status: 'running',
      runKey: KEY,
      note: '',
      runNow: false,
      mergeOk: false,
      merged: {},
      madeBy: 'person',
      position: 1,
      createdAt: at,
    });

    await flow.app.pipeline.runThrough(KEY, { auto: true });
    await flow.backlog().scheduler.tick();
    await get(BacklogPlanner).whenIdle();
    const turn = agent.prompts.find((launch) => launch.step === 'backlog-plan');
    // The run's planner took the question first, with the repository and the files, and passed it on.
    const own = agent.prompts.find((launch) => launch.step === 'plan');
    expect(own?.prompt).toContain('demo still conflicts in src/readme.ts');
    expect(turn?.prompt).toContain(`runKey: ${KEY}`);
    expect(turn?.prompt).toContain(ESCALATION);
    expect((await get(BacklogChatService).chat('shop')).turns.length).toBeGreaterThan(0);
    expect(['blocked', 'failed']).not.toContain((await stored()).state);
    await assertInvariants(flow.app);
  });
});
