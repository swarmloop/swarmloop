import 'reflect-metadata';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { createFlowHarness } from './flow-harness';
import { approvedRun } from './implement-flow.spec-helpers';
import { BlockAgentRunner } from './result-answer';

const KEY = 'PROJ-442';

describe('code-review retries after an invalid result', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  it.each(['quality', 'report'])('tells the %s agent its errors on the next visit', async (name) => {
    const step = `code-review-${name}`;
    const blocks = new BlockAgentRunner({ [step]: Array.from({ length: 6 }, () => ({ text: 'no result block' })) });
    flow = await createFlowHarness(KEY, { blocks, realImplement: 'all', realReview: true });
    const run = await approvedRun(flow, KEY, 'code-review');
    await flow.app.app.get(DocumentRepository).putDocument(run, 'implementation', '- changed the parser\n');

    await flow.app.pipeline.step('code-review', KEY);
    expect((await flow.app.app.get(RunRepository).findRun(KEY))?.status).toBe('failed');
    await flow.app.pipeline.step('code-review', KEY);
    expect((await flow.app.app.get(RunRepository).findRun(KEY))?.status).toBe('failed');
    await flow.person('resume');

    const prompt = blocks.prompts.filter((item) => item.step === step).at(-1)?.prompt;
    expect(prompt).toContain('The result block of your last answer was not accepted:');
    expect(prompt).toContain('no result block');
    expect((await flow.app.app.get(RunRepository).findRun(KEY))?.currentStep).toBe('done');
  });
});
