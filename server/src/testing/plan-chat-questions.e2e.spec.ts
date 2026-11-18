import 'reflect-metadata';
import { DocumentRepository } from '../history/document.repository';
import { PlanChatStore } from '../history/plan-chat.store';
import { RunRepository } from '../history/run.repository';
import { deriveState } from '../history/run-state';
import { createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { BlockAgentRunner, type ScriptedAnswer } from './result-answer';
import { remember } from './runs.spec-helpers';

const KEY = 'PROJ-710';
const FIRST = ['add the field - files: a.ts - proof: a.spec.ts', 'add the index - files: b.ts - proof: b.spec.ts'];
const QUESTION = 'Keep the cursor or the page number?';
const ANSWER = 'Cursor, as in the brief.';

const block = (value: unknown): ScriptedAnswer => ({ block: value });
const firstPlan = block({ summary: ['planned'], plan: FIRST, covers: [['R1'], ['R1']] });
const asks = (question: string): ScriptedAnswer =>
  block({ implementation: [], summary: ['stopped at a choice'], question });
const done = block({ implementation: ['changed the field'], summary: ['implemented the plan'] });

/** Runs a hook when a step launches, and records the tools of every planner launch. */
class QuestionRunner extends BlockAgentRunner {
  readonly planTools: string[] = [];
  hooks: Record<string, (() => Promise<void>) | undefined> = {};

  override async run(input: Parameters<BlockAgentRunner['run']>[0]) {
    if (input.step === 'plan') this.planTools.push((input as { tools?: string }).tools ?? 'missing');
    const hook = this.hooks[`${input.step}-${this.steps.filter((step) => step === input.step).length + 1}`];
    await hook?.();
    return super.run(input);
  }
}

describe('a step asks the planner', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let blocks: QuestionRunner;

  async function start(scripts: Record<string, ScriptedAnswer[]>): Promise<void> {
    blocks = new QuestionRunner({ ...scripts, plan: [firstPlan, ...(scripts.plan ?? [])] });
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

  it('takes the question of implement to the planner, waits holding no container, and continues implement in its own chat', async () => {
    await start({ implement: [asks(QUESTION), done], plan: [block({ reply: ANSWER })] });
    const waiting: unknown[] = [];
    blocks.hooks['plan-2'] = async () => {
      const run = (await runOf())!;
      waiting.push({ state: deriveState(run), attempt: run.activeAttempt });
    };

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    expect(blocks.steps.slice(0, 6)).toEqual([
      'plan',
      'plan-improve',
      'implement',
      'plan',
      'implement',
      'implement-improve',
    ]);
    expect(waiting).toMatchObject([{ state: { state: 'waiting', reason: { code: 'ASKS_PLANNER' } }, attempt: null }]);
    expect(launches('plan')[1].prompt).toContain(`The implement step asks:\n${QUESTION}`);
    const again = launches('implement')[1].prompt;
    expect(again).toContain('Answer from the planner:\nCursor, as in the brief.');
    expect(again).toContain('Decide any further open choice yourself');
    const entries = (await store().read(KEY)).entries;
    expect(entries.filter((entry) => entry.kind)).toMatchObject([
      { kind: 'question', from: 'implement', text: QUESTION, state: 'taken' },
      { kind: 'answer', from: 'implement', text: ANSWER, state: 'taken' },
    ]);
    expect(blocks.planTools.every((tools) => tools === 'plan')).toBe(true);
    expect((await runOf())?.currentStep).toBe('done');
    await assertInvariants(flow.app);
  });

  it('takes the question of implement-improve to the planner and continues it with the answer', async () => {
    await start({
      'implement-improve': [block({ summary: ['stopped at a choice'], question: QUESTION })],
      plan: [block({ reply: ANSWER })],
    });

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    expect(blocks.steps.slice(2, 7)).toEqual([
      'implement',
      'implement-improve',
      'plan',
      'implement-improve',
      'code-review-requirements',
    ]);
    expect(launches('implement-improve')[1].prompt).toContain('Answer from the planner:\nCursor, as in the brief.');
    expect(launches('implement')).toHaveLength(1);
    expect((await runOf())?.currentStep).toBe('done');
  });

  it('takes the question of a reviewer to the planner and runs only that reviewer again with the answer', async () => {
    const asking = block({ decision: 'ok', review: 'fine so far', summary: ['fine'], question: QUESTION });
    await start({ 'code-review-quality': [asking], plan: [block({ reply: ANSWER })] });

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    expect(launches('code-review-quality')).toHaveLength(2);
    for (const other of ['requirements', 'regressions', 'security', 'performance']) {
      expect(launches(`code-review-${other}`)).toHaveLength(1);
    }
    expect(launches('code-review-quality')[1].prompt).toContain('Answer from the planner:\nCursor, as in the brief.');
    expect(blocks.steps.indexOf('plan', 3)).toBeGreaterThan(blocks.steps.indexOf('code-review-quality'));
    expect((await runOf())?.currentStep).toBe('done');
    await assertInvariants(flow.app);
  });

  it('records a second question of the same visit as assumed: in the handoff and does not ask it', async () => {
    await start({
      implement: [
        asks(QUESTION),
        block({ implementation: ['changed the field'], summary: ['implemented'], question: 'Which index name?' }),
      ],
      plan: [block({ reply: ANSWER })],
    });

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    expect(launches('plan')).toHaveLength(2);
    expect((await store().read(KEY)).entries.filter((entry) => entry.kind === 'question')).toHaveLength(1);
    const handoff = (await flow.app.app.get(DocumentRepository).latestBody(KEY, 'handoff')) ?? '';
    expect(handoff).toContain('assumed: Which index name?');
    expect((await runOf())?.currentStep).toBe('done');
  });

  it('answers a person message and a step question one at a time, in the order they came', async () => {
    await start({
      implement: [asks(QUESTION), done],
      plan: [block({ reply: 'It is covered.' }), block({ reply: ANSWER })],
    });
    blocks.hooks['implement-1'] = async () => {
      await store().appendEntry(KEY, {
        key: 'message-1',
        role: 'person',
        author: 'ana',
        text: 'Is the empty page covered?',
        at: new Date(flow.app.clock.now()).toISOString(),
        state: 'pending',
      });
      flow.app.clock.advance(1000);
    };

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    const plans = launches('plan');
    expect(plans).toHaveLength(3);
    expect(plans[1].prompt).toContain('Is the empty page covered?');
    expect(plans[2].prompt).toContain(`The implement step asks:\n${QUESTION}`);
    expect(await store().pending(KEY)).toEqual([]);
    expect(await store().pendingQuestions(KEY)).toEqual([]);
    expect(launches('implement')[1].prompt).toContain('Answer from the planner:\nCursor');
    expect((await runOf())?.currentStep).toBe('done');
  });

  it('leaves the step waiting for the person when the planner escalates, and does not run it again', async () => {
    await start({
      implement: [asks(QUESTION), done],
      plan: [block({ reply: 'That is a product decision.', escalate: 'Which pagination do you want?' })],
    });

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    expect(launches('implement')).toHaveLength(1);
    const run = (await runOf())!;
    expect(run).toMatchObject({ status: 'waiting', state: 'waiting', currentStep: 'implement' });
    expect(await store().pendingQuestions(KEY)).toEqual([]);
    expect(await store().pendingEscalations(KEY)).toHaveLength(1);
  });
});
