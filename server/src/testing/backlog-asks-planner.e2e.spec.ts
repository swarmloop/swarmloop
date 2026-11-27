import 'reflect-metadata';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { RunAnswersService } from '../api/run-answers.service';
import { RunQueriesService } from '../api/run-queries.service';
import { BacklogChatService } from '../api/backlog-chat.service';
import { needsPerson } from '../contract/run-state';
import { BacklogRepository } from '../history/backlog.repository';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { storedState } from '../history/run-state';
import { remoteProject } from '../integrations/code-host/remote-project';
import { BacklogQueries } from '../pipeline/backlog/backlog-queries';
import { BacklogPlanner } from '../pipeline/backlog/planner/backlog-planner';
import { CommandService } from '../pipeline/command.service';
import { FAKE_MODEL_KEY } from './env.spec-helpers';
import { createFlowHarness } from './flow-harness';
import { BlockAgentRunner, DEFAULT_RESEARCH, type ScriptedAnswer } from './result-answer';
import { git, remember } from './runs.spec-helpers';

const KEY = 'b04';
const OWNER = 'owner';
const BACKLOG = 'shop';
const QUESTION = 'Which field is optional?';
const LEFT_LINE = "The planner's turn ended without answering this question, so it goes to you.";

/** The planner turn's result, which a spec fills in once the key of the run is known. */
function turnOf(say: string): { block: { say: string; actions: unknown[] } } {
  return { block: { say, actions: [] } };
}

describe('a question of a backlog run goes to the person only when the backlog planner passes it on', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  async function boot(planner: ScriptedAnswer[]): Promise<void> {
    const blocks = new BlockAgentRunner({
      research: [{ block: { ...DEFAULT_RESEARCH, questions: [QUESTION] } }],
      plan: [{ block: { summary: ['needs an answer'], plan: [], questions: [QUESTION], tasks: [] } }],
      'backlog-plan': planner,
    });
    flow = await createFlowHarness(KEY, {
      env: { CHECKOUTS_ROOT: '.', ...FAKE_MODEL_KEY },
      realImplement: false,
      realReview: false,
      blocks,
    });
    // The origin is an url, so the backlog layer reads a project from it.
    const url = `file://${join(flow.app.root, 'demo.git')}`;
    git(join(flow.app.root, 'demo'), ['remote', 'set-url', 'origin', url]);
    remoteProject(url);
    flow.host.defaultBranchPasses();
  }

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.app.app.get(CommandService).idle();
    await flow.close();
  });

  const get = <T>(token: new (...args: never[]) => T): T => flow.app.app.get(token);
  const backlogs = () => get(BacklogRepository);

  /** A backlog with one task, started: the scheduler gives it a run. */
  async function setUp(): Promise<number> {
    const { actions } = flow.backlog();
    await actions.createBacklog(OWNER, { name: BACKLOG, repositories: ['demo'], mergeMode: 'green' });
    await actions.proposeMilestone(OWNER, BACKLOG, { title: 'Ship the shop', goal: 'Customers can order.' });
    await actions.addRequirements(OWNER, BACKLOG, 1, { texts: ['Orders can be placed'] });
    await actions.addTasks(OWNER, BACKLOG, [
      {
        id: 'a',
        title: 'Task a',
        description: 'Do a.',
        repositories: ['demo'],
        files: ['src/a.ts'],
        proof: ['a.spec.ts'],
        milestone: 1,
        covers: ['M1.R1'],
        depends: [],
      },
    ]);
    await actions.runMilestone(OWNER, BACKLOG, 1);
    return (await backlogs().findBacklog(BACKLOG))!.id as number;
  }

  /** The run goes through a step, which asks its question, and waits there. */
  async function asking(runKey: string, step: 'research' | 'plan' = 'research'): Promise<void> {
    const run = await remember(get(RunRepository), get(DocumentRepository), runKey, step, 'waiting');
    if (step === 'plan') {
      // The plan step reads the worktree of the run and the requirements it has to cover.
      mkdirSync(join(flow.app.root, 'worktrees', runKey, 'demo'), { recursive: true });
      await get(DocumentRepository).putDocument(run, 'requirement_list', '[{"id":"R1","text":"ship the field"}]\n');
    }
    await flow.app.pipeline.step(step, runKey);
    await flow.app.pipeline.whenIdle(runKey);
    await flow.tick();
    const waiting = (await get(RunRepository).findRun(runKey))!;
    expect([waiting.currentStep, waiting.status]).toEqual([step, 'waiting']);
  }

  async function startedRun(id: number): Promise<string> {
    await flow.backlog().scheduler.tick();
    return (await backlogs().tasks(id))[0].runKey as string;
  }

  const stored = async (runKey: string) => storedState((await get(RunRepository).findRun(runKey))!);
  const items = async (runKey: string) => (await get(RunQueriesService).flow(runKey)).items;

  /** One scheduler pass and the planner turn it wakes. */
  async function plannerPass(): Promise<void> {
    await flow.backlog().scheduler.tick();
    await get(BacklogPlanner).whenIdle();
  }

  it('keeps the question with the planner: the run waits for the planner, the person is not asked, and the answer of the planner lets the run go on', async () => {
    const answer = turnOf('I answered the run.');
    await boot([answer]);
    const id = await setUp();
    const runKey = await startedRun(id);
    await asking(runKey, 'plan');

    expect((await stored(runKey)).reason?.code).toBe('ASKS_PLANNER');
    expect(await items(runKey)).toMatchObject([{ id: QUESTION, holder: 'planner' }]);
    expect((await items(runKey))[0].passedOn).toBeUndefined();
    const [before] = (await get(BacklogQueries).view(BACKLOG)).tasks;
    expect(needsPerson(before.run!.state, before.run!.stateReason)).toBe(false);

    answer.block.actions.push({
      action: 'answerRun',
      run: runKey,
      answers: [{ kind: 'question', id: QUESTION, body: 'The phone field.' }],
      reason: 'The requirements make only the phone optional.',
    });
    await plannerPass();

    expect(await get(DocumentRepository).latestBody(runKey, 'answers')).toContain('answer: The phone field.');
    expect(await get(DocumentRepository).latestBody(runKey, 'passed_on')).toBeNull();
    // The harness records the start of a run that is not its own: the answer asked the run to go on.
    expect(flow.launched).toContain(runKey);
  });

  it('gives the question to the person with the planner line once the planner passes it on', async () => {
    const pass = turnOf('Passing it on.');
    await boot([pass]);
    const id = await setUp();
    const runKey = await startedRun(id);
    await asking(runKey);

    pass.block.actions.push({
      action: 'passQuestion',
      run: runKey,
      question: QUESTION,
      reason: 'Only the owner knows the customers.',
    });
    await plannerPass();

    expect((await stored(runKey)).reason?.code).toBe('NEEDS_ANSWERS');
    const [shown] = await items(runKey);
    expect(shown).toMatchObject({ id: QUESTION, passedOn: 'Only the owner knows the customers.' });
    expect(shown.holder).toBeUndefined();
    const [task] = (await get(BacklogQueries).view(BACKLOG)).tasks;
    expect(needsPerson(task.run!.state, task.run!.stateReason)).toBe(true);
  });

  it('keeps the question with the planner while its turn waits on a usage limit, and a person can still answer it', async () => {
    await boot([{ limit: { window: '5-hour' } }, { limit: { window: '5-hour' } }]);
    const id = await setUp();
    const runKey = await startedRun(id);
    await asking(runKey);

    await plannerPass();

    const chat = await get(BacklogChatService).chat(BACKLOG);
    expect(chat.turns.map((turn) => turn.status)).toEqual(['waiting']);
    expect((await stored(runKey)).reason?.code).toBe('ASKS_PLANNER');
    expect(await items(runKey)).toMatchObject([{ id: QUESTION, holder: 'planner' }]);

    await get(RunAnswersService).answers(runKey, {
      answers: [{ kind: 'question', id: QUESTION, body: 'The email field.' }],
    });

    expect(await get(DocumentRepository).latestBody(runKey, 'answers')).toContain('answer: The email field.');
  });

  it('passes the question on as its turn ends when the turn neither answered nor passed it on, and says so in the chat', async () => {
    await boot([turnOf('I looked at it.')]);
    const id = await setUp();
    const runKey = await startedRun(id);
    await asking(runKey);

    await plannerPass();

    expect((await stored(runKey)).reason?.code).toBe('NEEDS_ANSWERS');
    expect(await items(runKey)).toMatchObject([{ id: QUESTION, passedOn: LEFT_LINE }]);
    const chat = await get(BacklogChatService).chat(BACKLOG);
    expect(chat.turns.map((turn) => turn.status)).toEqual(['done']);
    expect(chat.messages.map((message) => message.kind)).toEqual(['message', 'info']);
    expect(chat.messages[1].text).toContain('ended without answering');
  });

  it('asks the person at once for a run outside a backlog', async () => {
    await boot([]);
    await asking(KEY);

    expect((await stored(KEY)).reason?.code).toBe('NEEDS_ANSWERS');
    const [shown] = await items(KEY);
    expect(shown).toMatchObject({ id: QUESTION });
    expect(shown.holder).toBeUndefined();
    expect(shown.passedOn).toBeUndefined();
  });
});
