import 'reflect-metadata';
import { storeRun } from './store-run.spec-helpers';
import { DocumentRepository } from '../history/document.repository';
import { PlanChatStore } from '../history/plan-chat.store';
import { RunRepository } from '../history/run.repository';
import type { Subtask } from '../contract/subtask';
import { CommandService } from '../pipeline/command.service';
import { SubtaskPlannerAnswer } from '../pipeline/subtask-planner-answer';
import { StarterBriefing } from '../steps/shared/starter-briefing';
import { readPlan } from '../steps/plan/plan-record';
import { asksForStarter } from '../steps/shared/starter-asks';
import { createFlowHarness } from './flow-harness';
import { BlockAgentRunner, type ScriptedAnswer } from './result-answer';
import { remember } from './runs.spec-helpers';

const PARENT = 'PROJ-710';
const KEY = `${PARENT}-a`;
const FIRST = ['add the field - files: a.ts - proof: a.spec.ts', 'add the index - files: b.ts - proof: b.spec.ts'];
const AMENDED = [...FIRST, 'keep the old rows - files: c.ts - proof: c.spec.ts'];
const CONTRACT = '- limit (owner b): the page limit\n- own (owner a): the field\n';

const task = (id: string): Subtask => ({
  id,
  title: `Task ${id}`,
  description: `Do ${id}.`,
  depends: [],
  files: [`src/${id}.ts`],
  proof: `${id}.spec.ts`,
  status: 'waiting',
});

const block = (value: unknown): ScriptedAnswer => ({ block: value });
const firstPlan = block({ summary: ['planned'], plan: FIRST, covers: [['R1'], ['R1']] });

/** Sends a message while the first implement pass of the subtask runs, as a person does. */
class MessageDuringImplement extends BlockAgentRunner {
  send: (() => Promise<void>) | null = null;
  advance: (() => void) | null = null;

  override async run(input: Parameters<BlockAgentRunner['run']>[0]) {
    if (input.step === 'plan') this.advance?.();
    if (input.step === 'implement' && this.send) {
      const send = this.send;
      this.send = null;
      await send();
    }
    return super.run(input);
  }
}

describe("a person writes to a running subtask's planner", () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let blocks: MessageDuringImplement;

  async function start(plan: ScriptedAnswer[]): Promise<void> {
    blocks = new MessageDuringImplement({ plan: [firstPlan, ...plan] });
    flow = await createFlowHarness(KEY, { blocks, realImplement: 'all' });
    blocks.advance = () => flow.app.clock.advance(1000);
    const runs = flow.app.app.get(RunRepository);
    const documents = flow.app.app.get(DocumentRepository);
    const parent = await remember(runs, documents, PARENT, 'implement', 'waiting');
    await documents.putDocument(parent, 'contract', CONTRACT);
    const run = await remember(runs, documents, KEY, 'plan', 'waiting');
    run.parentRunId = parent.id;
    run.taskId = 'a';
    await storeRun(runs, run);
    await documents.putDocument(run, 'requirement_list', '[{"id":"R1","text":"ship the field"}]\n');
  }

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const store = () => flow.app.app.get(PlanChatStore);
  const message = (text: string) =>
    store().appendEntry(KEY, {
      key: 'message-1',
      role: 'person',
      author: 'Maksym',
      text,
      at: new Date(flow.app.clock.now()).toISOString(),
      state: 'pending',
    });

  it('amends its own plan, keeps going on its branch, and shows the parent one info line with the link', async () => {
    await start([block({ reply: 'Added.', summary: ['more'], plan: AMENDED, covers: [['R1'], ['R1'], ['R1']] })]);
    blocks.send = () => message('Also keep the old rows');

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    const amend = blocks.prompts.filter((launch) => launch.step === 'plan')[1].prompt;
    expect(amend).toContain('Items already done stay done');
    expect(amend).toContain('Change only what this task owns');
    expect(await store().pending(KEY)).toEqual([]);
    const implement = blocks.prompts.filter((launch) => launch.step === 'implement');
    expect(implement[1].prompt).toContain('- keep the old rows - files: c.ts - proof: c.spec.ts');
    const requirements = await flow.app.app.get(DocumentRepository).latestBody(KEY, 'requirements');
    expect(readPlan(requirements ?? '')?.items).toEqual(AMENDED);
    expect((await flow.app.app.get(RunRepository).findRun(KEY))?.currentStep).not.toBe('plan');

    const info = (await store().read(PARENT)).entries.filter((entry) => entry.kind === 'info');
    expect(info).toEqual([
      expect.objectContaining({
        text: 'Maksym → a: Also keep the old rows',
        reply: 'Added.',
        link: KEY,
        state: 'taken',
      }),
    ]);
  });

  it('sends a change of what another task owns up as a question, goes on, and the sibling gets the parent answer', async () => {
    await start([
      block({ reply: 'Noted.', decisions: [{ item: 'limit', text: 'The limit is ten.' }] }),
      block({ reply: 'That is for the parent.', question: 'Should the limit be ten?' }),
    ]);
    blocks.send = () => message('Make the page limit ten');

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    const plans = blocks.prompts.filter((launch) => launch.step === 'plan');
    expect(plans.length).toBeGreaterThanOrEqual(2);
    expect(plans[1].prompt).toContain('Change only what this task owns');
    // The task goes on past what it handed up.
    expect(blocks.steps.lastIndexOf('code-review-report')).toBeGreaterThan(blocks.steps.lastIndexOf('plan'));
    expect(asksForStarter(await store().read(KEY)).map((entry) => entry.text)).toEqual(['Should the limit be ten?']);
    expect(await store().pending(KEY)).toEqual([]);

    // The parent's planner answers it, and a running sibling reads the decision in its briefing.
    const runs = flow.app.app.get(RunRepository);
    const documents = flow.app.app.get(DocumentRepository);
    const parent = (await runs.findRun(PARENT))!;
    parent.split = true;
    parent.projects = 'demo\n';
    await storeRun(runs, parent);
    await documents.putDocument(
      parent,
      'requirements',
      `${JSON.stringify({
        prompt: 'Ship the field\n',
        tickets: [{ key: PARENT, summary: 'Ship the field' }],
        plan: { name: 'plan', overview: '', items: ['do it'], decision: 'approve' },
      })}\n`,
    );
    await documents.putDocument(parent, 'subtasks', `${JSON.stringify([task('a'), task('b'), task('c')])}\n`);
    jest.spyOn(SubtaskPlannerAnswer.prototype, 'askAbout').mockResolvedValue({ decision: 'The limit is ten.' });
    for (let pass = 0; pass < 2; pass += 1) {
      await flow.app.pipeline.step('implement', PARENT);
      await flow.app.app.get(CommandService).idle();
    }

    expect(asksForStarter(await store().read(KEY))).toEqual([]);
    const sibling = await runs.findRun(`${PARENT}-c`);
    const told = await new StarterBriefing(runs, documents).prepare(sibling!, 'implement', null, { continued: false });
    expect(told?.told).toContain('The limit is ten.');
  });
});
