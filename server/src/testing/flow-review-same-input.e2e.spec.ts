import 'reflect-metadata';
import { CODE_REVIEWERS } from '../contract/steps';
import { DocumentRepository } from '../history/document.repository';
import { PlanChatStore } from '../history/plan-chat.store';
import { RunRepository } from '../history/run.repository';
import { createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { BlockAgentRunner, type ScriptedAnswer } from './result-answer';

const KEY = 'PROJ-860';
const REQUIREMENTS = `${JSON.stringify({
  prompt: 'Ship the field\n',
  plan: { name: 'plan', overview: '', items: ['ship the field'], decision: 'approve' },
})}\n`;
const block = (value: unknown): ScriptedAnswer => ({ block: value });
const returns = block({ decision: 'return', review: 'The parser drops the last row.', summary: ['one finding'] });
const ok = block({ decision: 'ok', review: 'Looks right.', summary: ['fine'], reason: 'The fix holds.' });
const nothing = block({ implementation: [], summary: ['nothing to change'] });

describe('a run whose implement changes nothing after a return', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  afterEach(async () => {
    await flow.close();
  });

  it('starts no review round and no reviewer on the same input, asks the run’s planner', async () => {
    const blocks = new BlockAgentRunner({ 'code-review-quality': [returns, returns], implement: [nothing, nothing] });
    flow = await createFlowHarness(KEY, { blocks, realImplement: 'all', realReview: true, realHost: true });
    flow.fastWaits();
    const runs = flow.app.app.get(RunRepository);
    const run = await flow.begin('merge-request');
    run.currentStep = 'code-review';
    await flow.app.app.get(DocumentRepository).putDocument(run, 'requirements', REQUIREMENTS);
    await runs.saveRun(run);

    const ended = await flow.app.pipeline.runThrough(KEY, { auto: true });

    expect(ended.message).toContain('Not started again: same input as visit 1');
    for (const name of CODE_REVIEWERS) {
      expect(blocks.steps.filter((step) => step === `code-review-${name}`)).toHaveLength(1);
    }
    const after = (await runs.findRun(KEY))!;
    expect(after.status).toBe('waiting');
    const asked = (await flow.app.app.get(PlanChatStore).read(KEY)).entries.filter(
      (entry) => entry.kind === 'question',
    );
    expect(asked.map((entry) => [entry.from, entry.state])).toEqual([['code-review', 'pending']]);
    // The run's planner answers the question in the plan chat; the answer changes no file and no instruction.
    await flow.app.app.get(PlanChatStore).appendEntry(KEY, {
      key: 'answer-1',
      role: 'planner',
      kind: 'answer',
      from: 'code-review',
      text: 'The return stands.',
      at: new Date(flow.app.clock.now()).toISOString(),
      state: 'pending',
    });

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    for (const name of CODE_REVIEWERS) {
      expect(blocks.steps.filter((step) => step === `code-review-${name}`)).toHaveLength(1);
    }
    await assertInvariants(flow.app);
  });

  it('reviews again when implement changed a file and left it uncommitted', async () => {
    const blocks = new BlockAgentRunner({ 'code-review-quality': [returns, ok], implement: [nothing] });
    flow = await createFlowHarness(KEY, {
      blocks,
      realImplement: 'all',
      realReview: true,
      realHost: true,
      implementCommits: true,
    });
    flow.fastWaits();
    const runs = flow.app.app.get(RunRepository);
    const run = await flow.begin('merge-request');
    run.currentStep = 'code-review';
    await flow.app.app.get(DocumentRepository).putDocument(run, 'requirements', REQUIREMENTS);
    await runs.saveRun(run);

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    expect(blocks.steps.filter((step) => step === 'code-review-quality')).toHaveLength(2);
    await assertInvariants(flow.app);
  });
});
