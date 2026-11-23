import 'reflect-metadata';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { DocumentRepository } from '../history/document.repository';
import { PlanChatStore } from '../history/plan-chat.store';
import { RunRepository } from '../history/run.repository';
import { storedState } from '../history/run-state';
import { SubtaskPort } from '../pipeline/subtask-port';
import { createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { BlockAgentRunner, type ScriptedAnswer } from './result-answer';
import { remember } from './runs.spec-helpers';

const KEY = 'PROJ-850';
const FIRST = ['add the field - files: a.ts - proof: a.spec.ts', 'add the index - files: b.ts - proof: b.spec.ts'];
const QUESTION = 'Keep the cursor or the page number?';

const block = (value: unknown): ScriptedAnswer => ({ block: value });
const firstPlan = block({ summary: ['planned'], plan: FIRST, covers: [['R1'], ['R1']] });
const stops = block({ implementation: [], summary: ['stopped at a choice'], question: QUESTION });
const done = block({ implementation: ['changed the field'], summary: ['implemented the plan'] });
const passes = block({ decision: 'ok', review: 'fine now', summary: ['fine'] });
const asking = block({ decision: 'ok', review: 'fine so far', summary: ['fine'], question: QUESTION });

describe('the planner turns of a run pass the door', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let blocks: BlockAgentRunner;

  afterEach(async () => {
    await flow.close();
  });

  it('refuses the second planner turn on the same input: no launch, the run waits, the question goes one level up', async () => {
    blocks = new BlockAgentRunner({
      plan: [firstPlan, block({ reply: 'Cursor, as in the brief.' })],
      implement: [stops, done],
      'code-review-quality': [asking],
    });
    flow = await createFlowHarness(KEY, { blocks, realImplement: 'all' });
    const documents = flow.app.app.get(DocumentRepository);
    const run = await remember(flow.app.app.get(RunRepository), documents, KEY, 'plan', 'waiting');
    await documents.putDocument(run, 'requirement_list', '[{"id":"R1","text":"ship the field"}]\n');
    const levels: number[] = [];
    const reasons: (string | undefined)[] = [];
    const port = flow.app.app.get(SubtaskPort);
    const askUp = port.askUp.bind(port);
    jest.spyOn(port, 'askUp').mockImplementation(async (asking, question, level) => {
      levels.push(level ?? 0);
      reasons.push(storedState((await flow.app.app.get(RunRepository).findRun(asking.key))!).reason?.code);
      return askUp(asking, question, level);
    });

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    expect(blocks.prompts.filter((launch) => launch.step === 'plan')).toHaveLength(2);
    expect(levels).toEqual([1]);
    expect(reasons).toEqual(['SAME_INPUT']);
    const questions = (await flow.app.app.get(PlanChatStore).read(KEY)).entries.filter(
      (entry) => entry.kind === 'question',
    );
    expect(questions.map((entry) => entry.state)).toEqual(['taken', 'pending']);
    await assertInvariants(flow.app);
  });

  it('refuses the planner turn that answers the same reviewer question a second time: no launch, the run waits, the question goes one level up', async () => {
    blocks = new BlockAgentRunner({
      plan: [firstPlan, block({ reply: 'Cursor, as in the brief.' })],
      'code-review-quality': [asking, passes, asking],
    });
    flow = await createFlowHarness(KEY, { blocks, realImplement: 'all', realReview: true });
    flow.fastWaits();
    const documents = flow.app.app.get(DocumentRepository);
    const runs = flow.app.app.get(RunRepository);
    const run = await remember(runs, documents, KEY, 'plan', 'waiting');
    await documents.putDocument(run, 'requirement_list', '[{"id":"R1","text":"ship the field"}]\n');
    const levels: number[] = [];
    const reasons: (string | undefined)[] = [];
    const port = flow.app.app.get(SubtaskPort);
    const askUp = port.askUp.bind(port);
    jest.spyOn(port, 'askUp').mockImplementation(async (asking, question, level) => {
      levels.push(level ?? 0);
      reasons.push(storedState((await runs.findRun(asking.key))!).reason?.code);
      return askUp(asking, question, level);
    });

    await flow.app.pipeline.runThrough(KEY, { auto: true });
    const planLaunches = blocks.prompts.filter((launch) => launch.step === 'plan').length;
    const again = (await runs.findRun(KEY))!;
    again.currentStep = 'code-review';
    await runs.saveRun(again);
    writeFileSync(join(flow.tree, 'src', 'readme.ts'), 'export const readme = 2;\n');
    await flow.app.pipeline.step('code-review', KEY);
    await flow.app.pipeline.runThrough(KEY, { auto: true });
    expect(blocks.prompts.filter((launch) => launch.step === 'plan')).toHaveLength(planLaunches);
    expect(levels).toEqual([1]);
    expect(reasons).toEqual(['SAME_INPUT']);
    const questions = (await flow.app.app.get(PlanChatStore).read(KEY)).entries.filter(
      (entry) => entry.kind === 'question',
    );
    expect(questions.map((entry) => entry.state)).toEqual(['taken', 'pending']);
    await assertInvariants(flow.app);
  });
});
