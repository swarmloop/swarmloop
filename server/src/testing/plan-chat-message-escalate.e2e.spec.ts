import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { RunAnswersService } from '../api/run-answers.service';
import { RunQueriesService } from '../api/run-queries.service';
import { agentFor } from '../config/agents';
import { AppConfig } from '../config/env';
import { agentStateDir } from '../sandbox/sandbox-launch';
import { BacklogRepository } from '../history/backlog.repository';
import { DocumentRepository } from '../history/document.repository';
import { PlanChatStore } from '../history/plan-chat.store';
import { RunRepository } from '../history/run.repository';
import { storedState } from '../history/run-state';
import { remoteProject } from '../integrations/code-host/remote-project';
import { BacklogPlanner } from '../pipeline/backlog/planner/backlog-planner';
import { CommandService } from '../pipeline/command.service';
import { FAKE_MODEL_KEY } from './env.spec-helpers';
import { assertInvariants } from './flow-invariants';
import { createFlowHarness } from './flow-harness';
import { BlockAgentRunner, type ScriptedAnswer } from './result-answer';
import { git, remember } from './runs.spec-helpers';

const KEY = 'PROJ-730';
const OWNER = 'owner';
const BACKLOG = 'shop';
const DECIDE = 'Which pagination do you want?';
const DECISION = 'Use the cursor, as the person decided.';

const block = (value: unknown): ScriptedAnswer => ({ block: value });
const escalates = block({ reply: 'This is a product decision.', escalate: DECIDE });

const requirements = `${JSON.stringify({
  prompt: 'Ship the field\n',
  tickets: [{ key: KEY, summary: 'Ship the field' }],
  plan: { name: 'plan', overview: '', items: ['do it - files: a.ts - proof: a.spec.ts'], decision: 'approve' },
})}\n`;

/** The backlog planner's turn: its actions are filled in once the question is known. */
function turnOf(say: string): { block: { say: string; actions: unknown[] } } {
  return { block: { say, actions: [] } };
}

describe('a planner escalates in its reply to a message on the plan step path', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let blocks: BlockAgentRunner;

  async function boot(plan: ScriptedAnswer[], backlogPlanner: ScriptedAnswer[] = []): Promise<void> {
    blocks = new BlockAgentRunner({ plan, 'backlog-plan': backlogPlanner });
    flow = await createFlowHarness(KEY, {
      env: { CHECKOUTS_ROOT: '.', ...FAKE_MODEL_KEY },
      realImplement: false,
      realReview: false,
      blocks,
    });
    flow.fastWaits();
    const url = `file://${join(flow.app.root, 'demo.git')}`;
    git(join(flow.app.root, 'demo'), ['remote', 'set-url', 'origin', url]);
    remoteProject(url);
    flow.host.defaultBranchPasses();
  }

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.app.app.get(CommandService).idle();
    await flow.app.pipeline.whenIdle(KEY);
    await assertInvariants(flow.app);
    await flow.close();
  });

  const get = <T>(token: new (...args: never[]) => T): T => flow.app.app.get(token);
  const documents = () => get(DocumentRepository);
  const launches = (step: string) => blocks.prompts.filter((launch) => launch.step === step);
  const items = async () => (await get(RunQueriesService).flow(KEY)).items;
  const stored = async () => storedState((await get(RunRepository).findRun(KEY))!);

  /** A backlog whose one task is the run. */
  async function seedBacklog(): Promise<number> {
    flow.backlog();
    const backlogs = get(BacklogRepository);
    const at = new Date(flow.app.clock.now()).toISOString();
    const backlog = await backlogs.saveBacklog({
      name: BACKLOG,
      owner: OWNER,
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
      slug: 'a',
      title: 'Task a',
      description: 'Ship the field',
      repositories: ['demo'],
      covers: [],
      depends: [],
      files: [],
      proof: [],
      manual: false,
      fixesMain: null,
      status: 'waiting',
      runKey: KEY,
      note: '',
      runNow: false,
      mergeOk: false,
      merged: {},
      madeBy: 'person',
      position: 1,
      createdAt: at,
    });
    return backlog.id as number;
  }

  /** A run at plan with an approved plan and the planner's chat, which holds a message of the person for the plan step. */
  async function messaged(): Promise<void> {
    const run = await remember(get(RunRepository), documents(), KEY, 'plan', 'waiting');
    await documents().putDocument(run, 'requirements', requirements);
    await documents().putDocument(run, 'requirement_list', '[{"id":"R1","text":"ship the field"}]\n');
    mkdirSync(join(flow.app.root, 'worktrees', KEY, 'demo'), { recursive: true });
    mkdirSync(join(flow.app.root, 'data'), { recursive: true });
    mkdirSync(agentStateDir(flow.app.root, KEY, 'plan'), { recursive: true });
    const runtime = agentFor(get(AppConfig).env, run, 'plan').runtime;
    writeFileSync(
      join(flow.app.root, 'data', `${KEY}-plan-session.json`),
      JSON.stringify({ chatId: 'chat-1', runtime }),
    );
    await get(PlanChatStore).appendEntry(KEY, {
      key: 'message-1',
      role: 'person',
      author: 'ana',
      text: 'Should the list page?',
      at: new Date(flow.app.clock.now()).toISOString(),
      state: 'pending',
    });
  }

  const entries = async () => (await get(PlanChatStore).read(KEY)).entries;

  it('holds the question at the backlog planner, which answers the run planner in its own chat, and the run goes on', async () => {
    const backlog = turnOf('I decided for the owner.');
    await boot([escalates, block({ reply: DECISION })], [backlog]);
    const backlogId = await seedBacklog();
    await messaged();

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    expect((await stored()).reason?.code).toBe('ASKS_PLANNER');
    const [held] = await items();
    expect(held).toMatchObject({ kind: 'question', holder: 'planner' });
    expect(held.parts?.decide).toBe(DECIDE);
    const waitedAt = (await get(RunRepository).findRun(KEY))!.currentStep;

    backlog.block.actions.push({
      action: 'answerRun',
      run: KEY,
      answers: [{ kind: 'question', id: held.id, body: 'Cursor.' }],
      reason: 'The requirements name the cursor.',
    });
    await flow.backlog().scheduler.tick();
    await get(BacklogPlanner).whenIdle();
    await flow.app.pipeline.whenIdle(KEY);

    const events = await get(BacklogRepository).events(backlogId, 100);
    const asked = events.filter((event) => event.kind === 'run-asks-planner');
    expect(asked).toHaveLength(1);
    expect(asked[0].facts).toMatchObject({ runKey: KEY, questionId: held.id });
    expect(events.filter((event) => event.kind === 'run-needs-person')).toEqual([]);
    expect(launches('plan')[1].prompt).toContain('The person answered:\nCursor.');
    expect(await items()).toEqual([]);
    expect((await entries()).filter((entry) => entry.state === 'pending')).toEqual([]);
    expect((await get(RunRepository).findRun(KEY))!.currentStep).not.toBe(waitedAt);
  });

  it('asks the person on the run page for a run outside a backlog, and takes the answer the same way', async () => {
    await boot([escalates, block({ reply: DECISION })]);
    await messaged();

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    expect((await stored()).reason?.code).toBe('NEEDS_ANSWERS');
    const [item] = await items();
    expect(item).toMatchObject({ kind: 'question', answer: '' });
    expect(item.holder).toBeUndefined();
    expect(item.parts?.decide).toBe(DECIDE);
    const waitedAt = (await get(RunRepository).findRun(KEY))!.currentStep;

    await get(RunAnswersService).answers(KEY, { answers: [{ kind: 'question', id: item.id, body: 'Cursor.' }] });
    await flow.app.pipeline.whenIdle(KEY);

    expect(launches('plan')[1].prompt).toContain('The person answered:\nCursor.');
    expect(await items()).toEqual([]);
    expect((await entries()).filter((entry) => entry.state === 'pending')).toEqual([]);
    expect((await get(RunRepository).findRun(KEY))!.currentStep).not.toBe(waitedAt);
  });

  it('goes on as before with a reply that does not escalate', async () => {
    await boot([block({ reply: 'No, the list stays.' })]);
    await messaged();

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    expect((await entries()).filter((entry) => entry.kind === 'escalation')).toEqual([]);
    expect(await items()).toEqual([]);
    expect(launches('plan')).toHaveLength(1);
    expect((await get(RunRepository).findRun(KEY))!.currentStep).not.toBe('plan');
  });
});
