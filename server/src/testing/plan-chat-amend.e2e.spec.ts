import 'reflect-metadata';
import { storeRun } from './store-run.spec-helpers';
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DocumentRepository } from '../history/document.repository';
import { PlanChatStore } from '../history/plan-chat.store';
import { RunRepository } from '../history/run.repository';
import { VisitRepository } from '../history/visit.repository';
import { readPlan } from '../steps/plan/plan-record';
import { putStamped } from '../steps/shared/gate.spec-helpers';
import { createFlowHarness, useGitlabOrigin } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { BlockAgentRunner, type ScriptedAnswer } from './result-answer';
import { git, remember } from './runs.spec-helpers';
import { PlanChatService } from '../api/plan-chat.service';
import { PlannerTurns } from '../pipeline/planner-turns';
import { writeRunState } from '../history/run-state';

const KEY = 'PROJ-700';
const FIRST = ['add the field - files: a.ts - proof: a.spec.ts', 'add the index - files: b.ts - proof: b.spec.ts'];
const AMENDED = [...FIRST, 'keep the old rows - files: c.ts - proof: c.spec.ts'];

const block = (value: unknown): ScriptedAnswer => ({ block: value });
const firstPlan = block({ summary: ['planned'], plan: FIRST, covers: [['R1'], ['R1']] });

/** Sends a message while the first implement pass runs, as a person does. */
class MessageDuringImplement extends BlockAgentRunner {
  send: (() => Promise<void>) | null = null;

  /** Moves the fake clock, so a change of the plan is later than the visit before it. */
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

describe('a person writes to the planner after implement started, on a run that does not split', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let blocks: MessageDuringImplement;

  async function start(scripts: Record<string, ScriptedAnswer[]>, split = false): Promise<void> {
    blocks = new MessageDuringImplement({ ...scripts, plan: [firstPlan, ...(scripts.plan ?? [])] });
    flow = await createFlowHarness(KEY, { blocks, realImplement: 'all', implementCommits: true });
    flow.fastWaits();
    blocks.advance = () => flow.app.clock.advance(1000);
    const documents = flow.app.app.get(DocumentRepository);
    const run = await remember(flow.app.app.get(RunRepository), documents, KEY, 'plan', 'waiting');
    // `split` is what the settings let the planner do, not what it did: a run that may split and made one plan has no tasks.
    run.split = split;
    await storeRun(flow.app.app.get(RunRepository), run);
    await documents.putDocument(run, 'requirement_list', '[{"id":"R1","text":"ship the field"}]\n');
  }

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const store = () => flow.app.app.get(PlanChatStore);
  const runOf = () => flow.app.app.get(RunRepository).findRun(KEY);
  const message = (text: string) =>
    store().appendEntry(KEY, {
      key: 'message-1',
      role: 'person',
      author: 'ana',
      text,
      at: new Date(flow.app.clock.now()).toISOString(),
      state: 'pending',
    });

  it('shows the message pending while implement runs, takes it when implement ends and implements only the change', async () => {
    await start({
      plan: [block({ reply: 'Added.', summary: ['more'], plan: AMENDED, covers: [['R1'], ['R1'], ['R1']] })],
    });
    blocks.send = () => message('Also keep the old rows');

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    expect(blocks.steps.slice(0, 5)).toEqual(['plan', 'plan-improve', 'implement', 'plan', 'plan-improve']);
    const amend = blocks.prompts.filter((launch) => launch.step === 'plan')[1].prompt;
    expect(amend).toContain('Items already done stay done');
    expect(amend).toContain('Do not split the run into tasks.');
    expect(amend).not.toContain('tasks (array');
    expect(await store().pending(KEY)).toEqual([]);
    const implement = blocks.prompts.filter((launch) => launch.step === 'implement');
    expect(implement).toHaveLength(2);
    expect(implement[1].prompt).toContain('Plan amendment');
    expect(implement[1].prompt).toContain('- keep the old rows - files: c.ts - proof: c.spec.ts');
    expect(implement[1].prompt).not.toMatch(/Added:[^]*add the field - files/);
    expect(blocks.steps).toContain('code-review-report');
    const reviews = blocks.prompts.filter((launch) =>
      /^code-review-(requirements|quality|regressions|security|performance)$/.test(launch.step),
    );
    expect(reviews.length).toBeGreaterThanOrEqual(5);
    for (const review of reviews) {
      expect(review.prompt).toContain('Plan changes');
      expect(review.prompt).toContain('Plan v2: Also keep the old rows');
    }
    expect(readPlan((await flow.app.app.get(DocumentRepository).latestBody(KEY, 'requirements')) ?? '')?.items).toEqual(
      AMENDED,
    );
    expect((await runOf())?.currentStep).toBe('done');
    const visits = await flow.app.app.get(VisitRepository).listStats((await runOf())!.id);
    expect(visits.map((visit) => visit.step).slice(0, 8)).toEqual([
      'plan',
      'plan-improve',
      'branch',
      'implement',
      'plan',
      'plan-improve',
      'branch',
      'implement',
    ]);
    await assertInvariants(flow.app);
  });
  it('amends a run that may split but made one plan, and tells its plan and plan-improve visits not to split', async () => {
    await start(
      { plan: [block({ reply: 'Added.', summary: ['more'], plan: AMENDED, covers: [['R1'], ['R1'], ['R1']] })] },
      true,
    );
    blocks.send = () => message('Also keep the old rows');

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    const amend = blocks.prompts.filter((launch) => launch.step === 'plan')[1].prompt;
    expect(amend).toContain('Items already done stay done');
    expect(amend).toContain('Do not split the run into tasks.');
    expect(amend).not.toContain('tasks (array');
    const improve = blocks.prompts.filter((launch) => launch.step === 'plan-improve')[1].prompt;
    expect(improve).not.toContain('tasks (array');
    expect(readPlan((await flow.app.app.get(DocumentRepository).latestBody(KEY, 'requirements')) ?? '')?.items).toEqual(
      AMENDED,
    );
    expect((await runOf())?.currentStep).toBe('done');
  });

  it('lets the run go on with its next step for a reply without a plan, and reviewers get no Plan changes', async () => {
    await start({ plan: [block({ reply: 'It already covers that.' })] });
    blocks.send = () => message('Is the empty case covered?');

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    expect(blocks.steps.slice(0, 5)).toEqual(['plan', 'plan-improve', 'implement', 'plan', 'implement-improve']);
    expect(blocks.prompts.filter((launch) => launch.step === 'implement')).toHaveLength(1);
    expect(await store().pending(KEY)).toEqual([]);
    expect((await store().read(KEY)).revisions).toEqual([]);
    for (const review of blocks.prompts.filter((launch) => launch.step.startsWith('code-review-'))) {
      expect(review.prompt).not.toContain('Plan changes');
    }
    expect((await runOf())?.currentStep).toBe('done');
  });

  it('takes the message of a failed run before the resumed step and resumes', async () => {
    await start({
      'plan-turn': [block({ reply: 'Resuming.', resume: true })],
      plan: [block({ reply: 'Added.', summary: ['more'], plan: AMENDED, covers: [['R1'], ['R1'], ['R1']] })],
    });
    await flow.app.pipeline.runThrough(KEY, { auto: true });
    expect((await runOf())?.currentStep).toBe('done');
    const run = (await runOf())!;
    const before = blocks.steps.length;
    writeRunState(run, { status: 'failed', currentStep: 'checks' });
    await storeRun(flow.app.app.get(RunRepository), run);
    flow.app.clock.advance(1000);

    await flow.app.app.get(PlanChatService).send(KEY, 'Also keep the old rows', 'ana');
    await flow.app.app.get(PlannerTurns).idle();
    await flow.app.pipeline.whenIdle(KEY);

    expect(blocks.steps.slice(before, before + 3)).toEqual(['plan', 'plan-improve', 'implement']);
    expect((await runOf())?.currentStep).toBe('done');
    expect(await store().pending(KEY)).toEqual([]);
  });

  it('leaves a done run as it is for a reply without a plan', async () => {
    await start({ plan: [block({ reply: 'Nothing to change.' })] });
    await flow.app.pipeline.runThrough(KEY, { auto: true });
    const steps = blocks.steps.length;

    await flow.app.app.get(PlanChatService).send(KEY, 'Is it done?', 'ana');
    await flow.app.app.get(PlannerTurns).idle();

    expect(blocks.steps.slice(steps)).toEqual(['plan']);
    const run = (await runOf())!;
    expect([run.status, run.currentStep]).toEqual(['done', 'done']);
    expect((await store().read(KEY)).entries.at(-1)).toMatchObject({ role: 'planner', text: expect.any(String) });
  });

  it('reopens a done run only for a reply with a plan, and the new work goes through to done again', async () => {
    await start({
      plan: [block({ reply: 'Added.', summary: ['more'], plan: AMENDED, covers: [['R1'], ['R1'], ['R1']] })],
    });
    await flow.app.pipeline.runThrough(KEY, { auto: true });
    const steps = blocks.steps.length;

    await flow.app.app.get(PlanChatService).send(KEY, 'Also keep the old rows', 'ana');
    await flow.app.app.get(PlannerTurns).idle();
    await flow.app.pipeline.whenIdle(KEY);

    expect(blocks.steps.slice(steps, steps + 3)).toEqual(['plan', 'plan-improve', 'implement']);
    expect(blocks.prompts.filter((launch) => launch.step === 'implement').at(-1)?.prompt).toContain('Plan amendment');
    expect((await runOf())?.currentStep).toBe('done');
    await assertInvariants(flow.app);
  });
});

describe('a person writes to the planner of a done run whose merge request is open', () => {
  const FEATURE = `feature/${KEY}-ship-the-field`;
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let blocks: BlockAgentRunner;

  beforeEach(async () => {
    blocks = new BlockAgentRunner({
      plan: [firstPlan, block({ reply: 'Added.', summary: ['more'], plan: AMENDED, covers: [['R1'], ['R1'], ['R1']] })],
    });
    flow = await createFlowHarness(KEY, { blocks, realImplement: 'all', realReview: true, realHost: true });
    flow.fastWaits();
    useGitlabOrigin(flow.app.root, flow.tree);
    const runs = flow.app.app.get(RunRepository);
    const documents = flow.app.app.get(DocumentRepository);
    const run = await remember(runs, documents, KEY, 'requirements', 'waiting');
    run.codeHost = 'gitlab';
    await storeRun(runs, run);
    await documents.putDocument(run, 'requirement_list', '[{"id":"R1","text":"ship the field"}]\n');
    // The work the scripted agents leave no trace of: a commit on the feature branch for the merge request to carry.
    mkdirSync(join(flow.tree, 'src'), { recursive: true });
    writeFileSync(join(flow.tree, 'src', 'feature.ts'), 'export const feature = 1;\n');
    git(flow.tree, ['add', 'src/feature.ts']);
    git(flow.tree, ['commit', '-m', 'feat: ship the field']);
    git(flow.tree, ['push', 'origin', FEATURE]);
    const ref = `project: group/demo\nref: ${FEATURE}\nsha: ${git(flow.tree, ['rev-parse', 'HEAD'])}\n`;
    await putStamped(flow.app.app, run, 'pipeline_ref', ref, ['demo']);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  const settle = async (): Promise<void> => {
    for (let pass = 0; pass < 5; pass += 1) {
      await flow.tick();
      await flow.app.pipeline.whenIdle(KEY);
    }
  };

  it('puts the merge request back to draft while it works, updates its text and the run is done again', async () => {
    await flow.app.pipeline.runThrough(KEY);
    await settle();
    const runs = flow.app.app.get(RunRepository);
    expect((await runs.findRun(KEY))?.currentStep).toBe('done');
    const request = { project: 'group/demo', source: FEATURE };
    const opened = await flow.host.findMergeRequest(request);
    const before = opened.record!.summary;
    flow.app.clock.advance(1000);
    // The amended work is a new commit on the branch, so its review is a new input.
    await flow.recommit();

    await flow.app.app.get(PlanChatService).send(KEY, 'Also keep the old rows', 'ana');
    await flow.app.app.get(PlannerTurns).idle();
    expect((await flow.host.findMergeRequest(request)).record?.draft).toBe(true);
    await flow.app.pipeline.whenIdle(KEY);
    await settle();

    expect(blocks.prompts.filter((launch) => launch.step === 'implement').at(-1)?.prompt).toContain('Plan amendment');
    const after = await flow.host.findMergeRequest(request);
    expect(after.record?.summary).not.toBe(before);
    expect(after.record?.summary).toContain('<!-- swarmloop:report -->');
    expect(after.record?.draft).toBe(false);
    expect((await runs.findRun(KEY))?.currentStep).toBe('done');
  });
});
