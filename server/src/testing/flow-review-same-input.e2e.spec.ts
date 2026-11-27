import 'reflect-metadata';
import { storeRun } from './store-run.spec-helpers';
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
const asks = block({
  decision: 'return',
  review: 'The parser drops the last row.',
  summary: ['one finding'],
  question: 'Should the last row be kept?',
  reason: 'It still holds.',
});
const ok = block({ decision: 'ok', review: 'Looks right.', summary: ['fine'], reason: 'The fix holds.' });
const nothing = block({ implementation: [], summary: ['nothing to change'] });
const account = block({
  implementation: ['No file changed: the parser keeps the last row'],
  summary: ['The reader keeps the last row, so the finding does not apply.'],
  rejected: [
    { reviewer: 'quality', finding: 'The parser drops the last row.', reason: 'The last row is kept by the reader.' },
  ],
});

describe('a run whose implement changes nothing after a return', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  afterEach(async () => {
    await flow.close();
  });

  it('reviews once more by itself after an answer in implement’s account with no file change, and asks no one before that round', async () => {
    const blocks = new BlockAgentRunner({
      'code-review-quality': [returns, asks],
      implement: [account],
      'implement-improve': [account],
    });
    flow = await createFlowHarness(KEY, { blocks, realImplement: 'all', realReview: true, realHost: true });
    flow.fastWaits();
    const runs = flow.app.app.get(RunRepository);
    const run = await flow.begin('merge-request');
    run.currentStep = 'code-review';
    await flow.app.app.get(DocumentRepository).putDocument(run, 'requirements', REQUIREMENTS);
    await storeRun(runs, run);

    const ended = await flow.app.pipeline.runThrough(KEY, { auto: true });

    expect(ended.message).toContain('quality still returns');
    for (const name of CODE_REVIEWERS) {
      expect(blocks.steps.filter((step) => step === `code-review-${name}`)).toHaveLength(name === 'quality' ? 2 : 1);
    }
    const after = (await runs.findRun(KEY))!;
    expect(after.status).toBe('waiting');
    const asked = (await flow.app.app.get(PlanChatStore).read(KEY)).entries.filter(
      (entry) => entry.kind === 'question',
    );
    // The only question is the reviewer's, after round 2: none was asked between round 1 and round 2.
    expect(asked.map((entry) => [entry.from, entry.state])).toEqual([['code-review-quality', 'pending']]);
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
    await storeRun(runs, run);

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    expect(blocks.steps.filter((step) => step === 'code-review-quality')).toHaveLength(2);
    await assertInvariants(flow.app);
  });
});
