import 'reflect-metadata';
import { mkdirSync } from 'fs';
import { join } from 'path';
import { DocumentRepository } from '../history/document.repository';
import { PlanChatStore } from '../history/plan-chat.store';
import { RunRepository } from '../history/run.repository';
import { createFlowHarness } from './flow-harness';
import { assertInvariants } from './flow-invariants';
import { BlockAgentRunner, type ScriptedAnswer } from './result-answer';
import { remember } from './runs.spec-helpers';

const KEY = 'PROJ-870';
const block = (value: unknown): ScriptedAnswer => ({ block: value });
const firstPlan = block({
  summary: ['planned'],
  plan: ['add the field - files: a.ts - proof: a.spec.ts'],
  covers: [['R1']],
});
const done = block({ implementation: ['changed the field'], summary: ['implemented the plan'] });
const asks = (review: string, question: string, marks: object[] = []) =>
  block({
    decision: 'return',
    review,
    summary: ['one finding'],
    question,
    ...(marks.length > 0 ? { requirements: marks } : {}),
  });
const met = block({
  decision: 'ok',
  review: 'The field is there.',
  summary: ['met'],
  reason: 'The answer holds.',
  requirements: [{ id: 'R1', status: 'met', note: 'in the diff' }],
});
const passes = block({ decision: 'ok', review: 'The rows stay.', summary: ['ok'], reason: 'The answer holds.' });
const missing = [{ id: 'R1', status: 'missing', note: 'not there' }];
const answers = (finding: 'holds' | 'ruled-out', reply: string) => block({ reply, finding });

describe('a reviewer that returns with a question', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let blocks: BlockAgentRunner;

  async function start(scripts: Record<string, ScriptedAnswer[]>): Promise<void> {
    blocks = new BlockAgentRunner({ ...scripts, plan: [firstPlan, ...(scripts.plan ?? [])], implement: [done, done] });
    flow = await createFlowHarness(KEY, { blocks, realImplement: 'all', realReview: true, implementCommits: true });
    const documents = flow.app.app.get(DocumentRepository);
    const run = await remember(flow.app.app.get(RunRepository), documents, KEY, 'plan', 'waiting');
    await documents.putDocument(run, 'requirement_list', '[{"id":"R1","text":"ship the field"}]\n');
    mkdirSync(join(flow.app.root, 'worktrees', KEY, 'demo'), { recursive: true });
  }

  afterEach(async () => {
    await flow.close();
  });

  const launches = (step: string) => blocks.prompts.filter((launch) => launch.step === step);

  it('keeps its return: the planner says both returns stand, implement gets both, and review runs on its new head', async () => {
    await start({
      'code-review-requirements': [asks('The field is missing.', 'Is the field part of this change?', missing), met],
      'code-review-quality': [asks('The parser drops a row.', 'Should rows be kept in order?'), passes],
      plan: [answers('holds', 'The field is part of it.'), answers('holds', 'Rows keep their order.')],
    });

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    const second = launches('implement')[1].prompt;
    expect(second).toContain('The field is missing.');
    expect(second).toContain('The parser drops a row.');
    expect(second).toContain('The planner answered: The field is part of it.');
    expect(second).toContain('The planner answered: Rows keep their order.');
    // No reviewer ran between the answers and implement's second pass; each ran again only on its new head.
    const between = blocks.steps.slice(blocks.steps.indexOf('plan', 2), blocks.steps.lastIndexOf('implement'));
    expect(between.filter((step) => step.startsWith('code-review-'))).toEqual([]);
    expect(launches('code-review-requirements')).toHaveLength(2);
    expect(launches('code-review-quality')).toHaveLength(2);
    const entries = (await flow.app.app.get(PlanChatStore).read(KEY)).entries;
    expect(entries.filter((entry) => entry.kind === 'answer')).toMatchObject([
      { finding: 'holds', state: 'taken' },
      { finding: 'holds', state: 'taken' },
    ]);
    await assertInvariants(flow.app);
  });

  it('goes on as an ok round when the planner rules out the one return, and no reviewer runs again', async () => {
    await start({
      'code-review-requirements': [asks('The field is missing.', 'Is the field part of this change?', missing)],
      plan: [answers('ruled-out', 'The brief removes the field.')],
    });

    await flow.app.pipeline.runThrough(KEY, { auto: true });

    expect(launches('implement')).toHaveLength(1);
    expect(launches('code-review-requirements')).toHaveLength(1);
    expect(launches('code-review-quality')).toHaveLength(1);
    const review = await flow.app.app.get(DocumentRepository).latestBody(KEY, 'review_requirements');
    expect(review).toContain('decision: ok');
    expect(review).toContain('reason: The planner ruled the finding out: The brief removes the field.');
    expect((await flow.app.app.get(RunRepository).findRun(KEY))?.currentStep).toBe('done');
    await assertInvariants(flow.app);
  });
});
