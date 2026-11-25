import 'reflect-metadata';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { RunAnswersService } from '../api/run-answers.service';
import { RunQueriesService } from '../api/run-queries.service';
import { AGENT_RUNNER, type AgentRunInput, type AgentRunResult } from '../agent/agent-runner';
import { agentFor } from '../config/agents';
import { AppConfig } from '../config/env';
import { agentStateDir } from '../sandbox/sandbox-launch';
import { writeRunState } from '../history/run-state';
import { child, pass, seedParent, task, world, KEY as PARENT } from '../steps/implement/split-implement.spec-helpers';
import { resultAnswer } from './result-answer';
import type { TestApp } from './test-app';
import { PlannerTurns } from '../pipeline/planner-turns';
import { CommandService } from '../pipeline/command.service';
import { DocumentRepository } from '../history/document.repository';
import { PlanChatStore } from '../history/plan-chat.store';
import { RunRepository } from '../history/run.repository';
import { skillSection } from '../steps/shared/skill-prompt';
import { createFlowHarness } from './flow-harness';
import { BlockAgentRunner, type ScriptedAnswer } from './result-answer';
import { remember } from './runs.spec-helpers';

const KEY = 'PROJ-720';
const FIRST = ['add the field - files: a.ts - proof: a.spec.ts', 'add the index - files: b.ts - proof: b.spec.ts'];
const QUESTION = 'Keep the cursor or the page number?';
const DECIDE = 'Which pagination do you want?';
const DECISION = 'Use the cursor, as the person decided.';

const block = (value: unknown): ScriptedAnswer => ({ block: value });
const firstPlan = block({ summary: ['planned'], plan: FIRST, covers: [['R1'], ['R1']] });
const asks = block({ implementation: [], summary: ['stopped at a choice'], question: QUESTION });
const done = block({ implementation: ['changed the field'], summary: ['implemented the plan'] });
const GOAL = 'a block says why by its code and never by its text';
const STOP_FIRST = "the stop's code comes first";
const OLD_ROWS =
  'How do old stopped rows read when their latest error is left over from an earlier visit (a step that did not fit its budget, or a check that failed again on unchanged files)?';
const HELD_DECISION = `The row reads by the stop's code, because the goal says ${GOAL} and the run holds that ${STOP_FIRST}.`;
const escalates = block({ reply: 'This is a product decision.', escalate: DECIDE });

describe('a question the planner cannot settle goes to whoever started the run', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let blocks: BlockAgentRunner;

  async function start(scripts: Record<string, ScriptedAnswer[]>): Promise<void> {
    blocks = new BlockAgentRunner({ ...scripts, plan: [firstPlan, ...(scripts.plan ?? [])] });
    flow = await createFlowHarness(KEY, { blocks, realImplement: 'all' });
    const documents = flow.app.app.get(DocumentRepository);
    const run = await remember(flow.app.app.get(RunRepository), documents, KEY, 'plan', 'waiting');
    await documents.putDocument(run, 'requirement_list', '[{"id":"R1","text":"ship the field"}]\n');
  }

  afterEach(async () => {
    await flow.close();
  });

  const store = () => flow.app.app.get(PlanChatStore);
  const runOf = () => flow.app.app.get(RunRepository).findRun(KEY);
  const launches = (step: string) => blocks.prompts.filter((launch) => launch.step === step);
  const flowItems = async () => (await flow.app.app.get(RunQueriesService).flow(KEY)).items;

  async function escalated(): Promise<string> {
    await start({ implement: [asks, done], plan: [escalates, block({ reply: DECISION })] });
    await flow.app.pipeline.runThrough(KEY, { auto: true });
    const [item] = await flowItems();
    return item.id;
  }

  it('shows the escalated question to the person with its parts, and does not run implement again', async () => {
    const id = await escalated();

    const [item] = await flowItems();
    expect(item).toMatchObject({ kind: 'question', id, answer: '' });
    expect(item.label).toMatch(/^implement asks: Which pagination do you want\?/);
    expect(item.parts?.decide).toBe(DECIDE);
    expect(launches('implement')).toHaveLength(1);
    expect(launches('plan')).toHaveLength(2);
    expect(await store().pendingEscalations(KEY)).toHaveLength(1);
    expect((await runOf())?.currentStep).toBe('implement');
  });

  it('takes the answer of a person message through the planner back to implement, which goes on', async () => {
    await escalated();

    await flow.app.app.get(CommandService).submit('answer', KEY, { message: 'Cursor' });
    await flow.app.pipeline.whenIdle(KEY);

    const reading = launches('plan')[2].prompt;
    expect(reading).toContain(`You escalated a question of the implement step`);
    expect(reading).toContain(`The implement step had asked:\n${QUESTION}`);
    expect(reading).toContain('The person answered:\nCursor');
    expect(launches('implement')[1].prompt).toContain(`Answer from the planner:\n${DECISION}`);
    expect(await flowItems()).toEqual([]);
    expect(await store().pendingEscalations(KEY)).toEqual([]);
    expect((await runOf())?.currentStep).toBe('done');
  });

  it('takes the answer posted to the answers route the same way', async () => {
    const id = await escalated();

    await flow.app.app.get(RunAnswersService).answers(KEY, { answers: [{ kind: 'question', id, body: 'Cursor' }] });
    await flow.app.pipeline.whenIdle(KEY);

    expect(launches('implement')[1].prompt).toContain(`Answer from the planner:\n${DECISION}`);
    expect((await runOf())?.currentStep).toBe('done');
  });
});

describe('a review disagreement that implement and the reviewer did not settle', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let blocks: BlockAgentRunner;

  const returns = block({
    decision: 'return',
    review: 'requirements',
    summary: ['still missing'],
    requirements: [{ id: 'R1', status: 'missing', note: 'not there' }],
  });
  /** The same finding after implement answered it: a reviewer that saw an answer gives its reason. */
  const stillReturns = block({
    decision: 'return',
    review: 'requirements',
    summary: ['still missing'],
    reason: 'The field is still missing.',
    requirements: [{ id: 'R1', status: 'missing', note: 'not there' }],
  });
  /** The reviewer's next visit, after implement answered again: ok, with its reason. */
  const settles = block({
    decision: 'ok',
    review: 'requirements',
    summary: ['the answer holds'],
    reason: 'The answer holds.',
    requirements: [{ id: 'R1', status: 'met', note: 'the plan removes it' }],
  });
  const keeps = block({
    implementation: [],
    summary: ['kept as it is'],
    rejected: [{ reviewer: 'requirements', finding: 'the field is missing', reason: 'The plan removes it.' }],
  });

  async function start(
    plan: ScriptedAnswer[],
    { requirement = 'ship the field', reviews = [returns, stillReturns, settles] } = {},
  ): Promise<void> {
    blocks = new BlockAgentRunner({
      plan: [firstPlan, ...plan],
      implement: [done, keeps],
      'code-review-requirements': reviews,
    });
    flow = await createFlowHarness(KEY, { blocks, realImplement: 'all', realReview: true, implementCommits: true });
    const documents = flow.app.app.get(DocumentRepository);
    const run = await remember(flow.app.app.get(RunRepository), documents, KEY, 'plan', 'waiting');
    await documents.putDocument(run, 'requirement_list', JSON.stringify([{ id: 'R1', text: requirement }]) + '\n');
    mkdirSync(join(flow.app.root, 'worktrees', KEY, 'demo'), { recursive: true });
  }

  afterEach(async () => {
    await flow.close();
  });

  const questions = () => flow.app.app.get(DocumentRepository).latestBody(KEY, 'review_questions');
  const asked = async () => (await flow.app.app.get(PlanChatStore).read(KEY)).entries.filter((e) => e.kind);

  it('goes to the planner first and not to the person', async () => {
    await start([block({ reply: 'The plan removes that field.', finding: 'holds' })]);

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    expect(await asked()).toMatchObject([
      { kind: 'question', from: 'code-review-requirements', state: 'taken' },
      { kind: 'answer', from: 'code-review-requirements', text: 'The plan removes that field.' },
    ]);
    expect(await questions()).toBeNull();
    expect((await flow.app.app.get(RunQueriesService).flow(KEY)).items).toEqual([]);
  });

  it('is decided by the planner when its brief and its decisions answer it, and no one is asked', async () => {
    const old = (reason?: string) =>
      block({
        decision: 'return',
        review: 'requirements',
        summary: ['rows do not say how they read'],
        ...(reason ? { reason } : {}),
        requirements: [{ id: 'R1', status: 'missing', note: OLD_ROWS }],
      });
    await start([block({ reply: HELD_DECISION, finding: 'holds' })], {
      requirement: `${GOAL}; ${STOP_FIRST}`,
      reviews: [old(), old('Old stopped rows still do not say how they read.'), settles],
    });

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    const planLaunch = blocks.prompts.filter((launch) => launch.step === 'plan').at(-1);
    expect(planLaunch?.prompt).toContain('requirements still returns');
    expect(planLaunch?.prompt).toContain(skillSection('plan', 'Decide what you hold'));
    const entries = await asked();
    expect(entries).toMatchObject([
      { kind: 'question', from: 'code-review-requirements', state: 'taken' },
      { kind: 'answer', from: 'code-review-requirements', text: HELD_DECISION },
    ]);
    expect(entries.some((entry) => entry.kind === 'escalation')).toBe(false);
    expect(await questions()).toBeNull();
    expect((await flow.app.app.get(RunQueriesService).flow(KEY)).items).toEqual([]);
  });

  it('reaches the person only when the planner escalates', async () => {
    await start([block({ reply: 'This is a product decision.', escalate: DECIDE, finding: 'holds' })]);

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    const [item] = (await flow.app.app.get(RunQueriesService).flow(KEY)).items;
    expect(item).toMatchObject({ kind: 'question', answer: '' });
    expect(item.parts?.decide).toBe(DECIDE);
    expect(await asked()).toMatchObject([
      { kind: 'question', from: 'code-review-requirements' },
      { kind: 'escalation', from: 'code-review-requirements' },
    ]);
  });
});

describe('a subtask asks the planner of its parent', () => {
  let app: TestApp;

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  /** A split parent with a plan chat and two subtasks that ran once; the parent's planner gives `reply`, or fails when it is empty. */
  async function splitWorld(reply: string) {
    app = (await world()).app;
    const documents = app.app.get(DocumentRepository);
    const parent = await seedParent(app, [task('a'), task('b')]);
    await documents.putDocument(parent, 'contract', '- names are camelCase\n');
    await documents.putDocument(parent, 'repos', 'demo\n');
    const runtime = agentFor(app.app.get(AppConfig).env, parent, 'plan').runtime;
    mkdirSync(join(app.root, 'data'), { recursive: true });
    mkdirSync(agentStateDir(app.root, PARENT, 'plan'), { recursive: true });
    writeFileSync(join(app.root, 'data', `${PARENT}-plan-session.json`), JSON.stringify({ chatId: 'c-1', runtime }));
    mkdirSync(join(app.root, 'worktrees', PARENT, 'demo'), { recursive: true });
    const prompts: string[] = [];
    const ordered: boolean[] = [];
    jest
      .spyOn(app.app.get<{ run: (input: AgentRunInput) => Promise<AgentRunResult> }>(AGENT_RUNNER), 'run')
      .mockImplementation((input) => {
        prompts.push(input.prompt);
        ordered.push(app.app.get(PlannerTurns).replying(PARENT));
        return Promise.resolve({
          responseText: reply ? resultAnswer('Done.', { decision: reply }) : '',
          chatId: 'c-1',
          tokensIn: 10,
          tokensOut: 5,
          usd: 0.5,
          killReason: null,
          exitCode: reply ? 0 : 1,
          resumed: true,
          calls: 1,
          samples: [],
          durationMs: 1,
          startedAt: new Date(0).toISOString(),
          finishedAt: new Date(1).toISOString(),
        });
      });
    await pass(app);
    return { documents, prompts, parent, ordered };
  }

  /** The subtask `a` waits at implement with what its own planner escalated, pending in its own chat. */
  async function asks(): Promise<string> {
    const run = await child(app, 'a');
    writeRunState(run, { status: 'waiting', currentStep: 'implement' });
    await app.app.get(RunRepository).saveRun(run);
    await app.app.get(PlanChatStore).appendEntry(run.key, {
      key: 'escalate-ask-implement-1',
      role: 'planner',
      kind: 'escalation',
      from: 'implement',
      text: 'Which field?',
      at: '2026-01-01T00:00:00.000Z',
      state: 'pending',
    });
    return run.key;
  }

  it('gets its answer from the parent planner into its own chat, and goes on', async () => {
    const { prompts, documents, ordered } = await splitWorld('Use a column.');
    const key = await asks();

    await pass(app);

    expect(ordered).toEqual([true]);

    expect(prompts[0]).toContain('Subtask a asks:\n- Which field?');
    const chat = await app.app.get(PlanChatStore).read(key);
    expect(chat.entries).toMatchObject([
      { kind: 'escalation', from: 'implement', text: 'Which field?', state: 'taken' },
      { kind: 'answer', from: 'implement', text: 'Use a column.', state: 'pending' },
    ]);
    expect(await documents.latestBody(PARENT, 'contract')).toMatch(/- subtask a at \S+: Use a column\./);
    expect(await documents.latestBody(PARENT, 'subtask_questions')).toBeNull();
  });

  it('is decided by the parent planner from its contract, and the person is not asked', async () => {
    const { prompts, documents, parent } = await splitWorld(HELD_DECISION);
    await documents.putDocument(parent, 'contract', `- names are camelCase\n- ${STOP_FIRST}\n`);
    const run = await child(app, 'a');
    writeRunState(run, { status: 'waiting', currentStep: 'code-review' });
    await app.app.get(RunRepository).saveRun(run);
    await documents.putDocument(run, 'review_questions', `- ${OLD_ROWS}\n`);

    await pass(app);

    expect(prompts[0]).toContain(`The contract now:\n- names are camelCase\n- ${STOP_FIRST}`);
    expect(prompts[0]).toContain(skillSection('plan', 'Decide what you hold'));
    expect(prompts[0]).toContain(skillSection('plan', 'Escalate what you do not hold'));
    expect(await documents.latestBody(PARENT, 'contract')).toContain(`- subtask a at`);
    expect(await documents.latestBody(PARENT, 'contract')).toContain(HELD_DECISION);
    expect(await documents.latestBody(PARENT, 'subtask_questions')).toBeNull();
    expect((await app.app.get(RunQueriesService).flow(PARENT)).items).toEqual([]);
  });

  it('asks the person of the parent when the planner gives no answer, and hands the answer to the subtask', async () => {
    const { documents, parent } = await splitWorld('');
    const key = await asks();

    await pass(app);

    const [line] = (await app.app.get(RunQueriesService).flow(PARENT)).items;
    expect(line.label).toMatch(/^Subtask a asks: - Which field\?/);
    expect((await app.app.get(PlanChatStore).read(key)).entries.map((entry) => entry.state)).toEqual(['pending']);

    await documents.putDocument(parent, 'answers', `question: ${line.id}\nanswer: Use a column.\n`);
    await pass(app);

    expect((await app.app.get(PlanChatStore).read(key)).entries).toMatchObject([
      { kind: 'escalation', state: 'taken' },
      { kind: 'answer', from: 'implement', text: 'Use a column.', state: 'pending' },
    ]);
    expect(await documents.latestBody(PARENT, 'contract')).toMatch(/- subtask a at \S+: Use a column\./);
  });
});
