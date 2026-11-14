import 'reflect-metadata';
import { CommandService } from '../pipeline/command.service';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { createFlowHarness } from './flow-harness';
import { approvedRun } from './implement-flow.spec-helpers';
import { BlockAgentRunner } from './result-answer';
import { remember } from './runs.spec-helpers';

const KEY = 'PROJ-441';
const UPDATED_PLAN = 'store it in a column - files: column.ts - proof: column.spec.ts';
const invalid = () => Array.from({ length: 3 }, () => ({ text: 'no result block' }));

describe('replay after an invalid result', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  it('keeps the instructions when replaying the step whose answer failed', async () => {
    const blocks = new BlockAgentRunner({ plan: invalid() });
    flow = await createFlowHarness(KEY, { blocks, realImplement: 'all' });
    await remember(flow.app.app.get(RunRepository), flow.app.app.get(DocumentRepository), KEY, 'plan', 'waiting');
    await flow.app.pipeline.step('plan', KEY);
    expect((await flow.app.app.get(RunRepository).findRun(KEY))?.status).toBe('failed');

    await flow.app.app.get(CommandService).submit('replay', KEY, { step: 'plan', prompt: UPDATED_PLAN });
    await flow.app.pipeline.whenIdle(KEY);

    const prompt = blocks.prompts.filter((item) => item.step === 'plan').at(-1)?.prompt;
    expect(prompt).toContain('Latest user instructions:');
    expect(prompt).toContain(UPDATED_PLAN);
    expect((await flow.app.app.get(RunRepository).findRun(KEY))?.currentStep).toBe('done');
  });

  it('gives implement the new checklist when replaying from plan after its answer failed', async () => {
    const blocks = new BlockAgentRunner({
      implement: invalid(),
      plan: [{ block: { summary: ['new plan'], plan: [UPDATED_PLAN] } }],
    });
    flow = await createFlowHarness(KEY, { blocks, realImplement: 'all' });
    await approvedRun(flow, KEY, 'implement');
    await flow.app.pipeline.step('implement', KEY);
    expect((await flow.app.app.get(RunRepository).findRun(KEY))?.status).toBe('failed');

    await flow.app.app.get(CommandService).submit('replay', KEY, { step: 'plan', prompt: UPDATED_PLAN });
    await flow.app.pipeline.whenIdle(KEY);

    const prompt = blocks.prompts.filter((item) => item.step === 'implement').at(-1)?.prompt;
    expect(prompt).toContain(UPDATED_PLAN);
    expect((await flow.app.app.get(RunRepository).findRun(KEY))?.currentStep).toBe('done');
  });
});
