import 'reflect-metadata';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { DocumentRepository } from '../history/document.repository';
import { PlanChatStore } from '../history/plan-chat.store';
import { RunRepository } from '../history/run.repository';
import { readPlan } from '../steps/plan/plan-record';
import { BlockAgentRunner, type ScriptedAnswer } from './result-answer';
import { createTestApp, type TestApp } from './test-app';

const KEY = 'PROJ-600';
const FIRST = ['add the field - files: a.ts - proof: a.spec.ts'];
const REVISED = ['add the field and its index - files: a.ts - proof: a.spec.ts'];

const block = (value: unknown): ScriptedAnswer => ({ block: value });
const firstPlan = block({ summary: ['planned'], plan: FIRST, covers: [['R1']] });
const person = (text: string, key = 'message-1') => ({
  key,
  role: 'person' as const,
  author: 'ana',
  text,
  at: '2026-11-17T09:00:00.000Z',
  state: 'pending' as const,
});

/** Sends a message in the middle of the first planning visit, as a person does while the planner works. */
class MessageDuringPlan extends BlockAgentRunner {
  onFirstPlan: (() => Promise<void>) | null = null;

  override async run(input: Parameters<BlockAgentRunner['run']>[0]) {
    if (input.step === 'plan' && this.onFirstPlan) {
      const send = this.onFirstPlan;
      this.onFirstPlan = null;
      await send();
    }
    return super.run(input);
  }
}

describe('a person writes to the planner while the run plans', () => {
  let app: TestApp;
  let blocks: MessageDuringPlan;

  async function start(plans: ScriptedAnswer[]): Promise<void> {
    blocks = new MessageDuringPlan({ plan: plans });
    app = await createTestApp({
      envFile: false,
      blocks,
      realSteps: ['plan', 'plan-improve'],
      realImplement: false,
      realReview: false,
    });
    const runs = app.app.get(RunRepository);
    const documents = app.app.get(DocumentRepository);
    mkdirSync(join(app.root, 'worktrees', KEY, 'billing-api'), { recursive: true });
    const run = await runs.begin(KEY, 'plan');
    run.status = 'waiting';
    await runs.saveRun(run);
    await documents.putDocument(run, 'requirements', '{"prompt":"ship the field"}\n');
    await documents.putDocument(run, 'repos', 'billing-api\n');
    await documents.putDocument(run, 'requirement_list', '[{"id":"R1","text":"ship the field"}]\n');
  }

  afterEach(async () => {
    await app.close();
  });

  const store = () => app.app.get(PlanChatStore);
  const stepOf = async () => (await app.app.get(RunRepository).findRun(KEY))?.currentStep;
  const plan = async () => readPlan((await app.app.get(DocumentRepository).latestBody(KEY, 'requirements')) ?? '');
  const planned = async () => {
    await app.pipeline.step('plan', KEY);
    await app.pipeline.whenIdle(KEY);
  };

  it('goes from plan to the next step without waiting when nobody writes', async () => {
    await start([firstPlan]);
    await planned();
    await app.pipeline.step('plan-improve', KEY);
    expect(await stepOf()).toBe('branch');
    expect(blocks.steps).toEqual(['plan', 'plan-improve']);
  });

  it('takes a message in the next plan visit, in the same chat, and the revised plan passes plan-improve', async () => {
    await start([firstPlan, block({ reply: 'Added an index.', summary: ['index'], plan: REVISED, covers: [['R1']] })]);
    await planned();
    await store().appendEntry(KEY, person('Please add an index'));

    await app.pipeline.step('plan-improve', KEY);
    expect(await stepOf()).toBe('plan');

    await planned();
    expect(blocks.prompts[blocks.prompts.length - 1].prompt).toContain('Please add an index');
    expect((await plan())?.items).toEqual(REVISED);
    expect(await stepOf()).toBe('plan-improve');

    await app.pipeline.step('plan-improve', KEY);
    expect(await stepOf()).toBe('branch');
    expect((await plan())?.decision).toBe('approve');
    const log = await store().read(KEY);
    expect(log.entries.map((entry) => [entry.role, entry.state, entry.version])).toEqual([
      ['person', 'taken', undefined],
      ['planner', 'taken', 2],
    ]);
    expect(log.revisions).toMatchObject([{ version: 2, reason: 'Please add an index' }]);
  });

  it('leaves a message sent while a planning visit runs for the next visit', async () => {
    await start([firstPlan, block({ reply: 'Noted.' })]);
    blocks.onFirstPlan = () => store().appendEntry(KEY, person('sent during the visit'));
    await planned();
    expect((await store().pending(KEY)).map((entry) => entry.key)).toEqual(['message-1']);

    await app.pipeline.step('plan-improve', KEY);
    expect(await stepOf()).toBe('plan');
    await planned();
    expect(await store().pending(KEY)).toEqual([]);
    expect(await stepOf()).toBe('branch');
  });

  it('keeps the plan for a reply with no plan and goes on', async () => {
    await start([firstPlan, block({ reply: 'It already covers that.' })]);
    await planned();
    await store().appendEntry(KEY, person('Is the empty case covered?'));
    await app.pipeline.step('plan-improve', KEY);
    expect(await stepOf()).toBe('plan');
    await planned();
    expect((await plan())?.items).toEqual(FIRST);
    expect((await store().read(KEY)).revisions).toEqual([]);
    expect(await stepOf()).toBe('branch');
    expect(blocks.steps).toEqual(['plan', 'plan-improve', 'plan']);
  });

  it('adds a new requirement under the next id and asks once more for a plan that does not cover it', async () => {
    const both = ['add the field - files: a.ts - proof: a.spec.ts', 'keep old rows - files: b.ts - proof: b.spec.ts'];
    await start([
      firstPlan,
      block({ reply: 'Added.', requirements: ['keep the old rows'], summary: ['s'], plan: FIRST, covers: [['R1']] }),
      block({ reply: 'Covered.', summary: ['s'], plan: both, covers: [['R1'], ['R2']] }),
    ]);
    await planned();
    await store().appendEntry(KEY, person('Also keep the old rows'));
    await app.pipeline.step('plan-improve', KEY);
    await planned();

    const prompts = blocks.prompts.filter((entry) => entry.step === 'plan');
    expect(prompts).toHaveLength(3);
    expect(prompts[2].prompt).toContain('R2 is not covered: keep the old rows');
    const list = JSON.parse((await app.app.get(DocumentRepository).latestBody(KEY, 'requirement_list')) ?? '[]');
    expect(list).toEqual([
      { id: 'R1', text: 'ship the field' },
      { id: 'R2', text: 'keep the old rows' },
    ]);
    await app.pipeline.step('plan-improve', KEY);
    expect(await stepOf()).toBe('branch');
  });
});
