import 'reflect-metadata';
import { RunQueriesService } from '../api/run-queries.service';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { handoffText } from '../steps/shared/handoff';
import { SubtaskOps } from '../steps/shared/subtask-ops';
import { createFlowHarness } from './flow-harness';
import { BlockAgentRunner, DEFAULT_RESEARCH } from './result-answer';
import { withPlan } from '../steps/plan/plan-record';
import { approvedRun } from './implement-flow.spec-helpers';
import { remember } from './runs.spec-helpers';

const KEY = 'PROJ-470';
const QUESTION = 'Which field is optional?';

/** Runs that started before results were stored hold the rendered documents only. Each step group adds its case here. */
describe('a run stored before results', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;
  let blocks: BlockAgentRunner;

  beforeEach(async () => {
    blocks = new BlockAgentRunner({}, { research: DEFAULT_RESEARCH });
    flow = await createFlowHarness(KEY, { blocks });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  it('waiting in research with old documents shows its answered question and goes on to done', async () => {
    const runs = flow.app.app.get(RunRepository);
    const documents = flow.app.app.get(DocumentRepository);
    const run = await remember(runs, documents, KEY, 'research', 'waiting');
    await documents.putDocument(run, 'questions', `- ${QUESTION}\n`);
    await documents.putDocument(run, 'answers', `question: ${QUESTION}\nanswer: the column\n`);
    await documents.putDocument(run, 'impact', '- stop button | stop.tsx | kept\n');
    await documents.putDocument(run, 'needs', 'needs:\n- t0: the retry policy\n');
    expect(await documents.latestBody(KEY, 'research_result')).toBeNull();

    const view = await flow.app.app.get(RunQueriesService).flow(KEY);
    expect(view.items).toEqual([{ kind: 'question', id: QUESTION, label: QUESTION, answer: 'the column' }]);
    expect(await flow.app.app.get(SubtaskOps).needsOf(run)).toEqual([{ id: 't0', what: 'the retry policy' }]);

    await flow.person('resume');

    expect((await runs.findRun(KEY))?.status).toBe('done');
    expect(blocks.prompts.find((item) => item.step === 'research')?.prompt).toContain('the column');
    expect(await documents.latestBody(KEY, 'research_result')).toContain('"questions":[]');
  });

  it('waiting in research with a Markdown handoff keeps its sections as JSON and goes on to done', async () => {
    const runs = flow.app.app.get(RunRepository);
    const documents = flow.app.app.get(DocumentRepository);
    const run = await remember(runs, documents, KEY, 'research', 'waiting');
    const old = '## requirements\n- the form saves\n\n## prepare\n- prepared the repository\n';
    await documents.putDocument(run, 'handoff', old);

    const view = await flow.app.app.get(RunQueriesService).flow(KEY);
    expect(JSON.stringify(view)).not.toContain('"step":"requirements"');

    await flow.app.pipeline.step('research', KEY);

    expect((await runs.findRun(KEY))?.currentStep).toBe('plan');
    const stored = (await documents.latestBody(KEY, 'handoff')) ?? '';
    expect(JSON.parse(stored).slice(0, 2)).toEqual([
      { step: 'requirements', body: '- the form saves' },
      { step: 'prepare', body: '- prepared the repository' },
    ]);
    expect(handoffText(stored)).toContain(old.trimEnd());
    const prompt = blocks.prompts.find((item) => item.step === 'research')?.prompt ?? '';
    expect(prompt).toContain('## requirements\n- the form saves\n\n## prepare\n- prepared the repository\n');
    await flow.person('resume');
    expect((await runs.findRun(KEY))?.status).toBe('done');
  });

  it('waiting in plan-improve with the plan in the requirements record only keeps it and goes on to done', async () => {
    const runs = flow.app.app.get(RunRepository);
    const documents = flow.app.app.get(DocumentRepository);
    const run = await remember(runs, documents, KEY, 'plan-improve', 'waiting');
    const old = { name: '', overview: '', items: ['add the field - files: a.ts - proof: a.spec.ts'], decision: null };
    const body = (await documents.latestBody(KEY, 'requirements')) ?? '';
    await documents.putDocument(run, 'requirements', withPlan(body, old));
    await documents.putDocument(run, 'questions', '');
    expect(await documents.latestBody(KEY, 'plan_result')).toBeNull();

    await flow.person('resume');

    expect((await runs.findRun(KEY))?.status).toBe('done');
    const prompt = blocks.prompts.find((item) => item.step === 'plan-improve')?.prompt ?? '';
    expect(prompt).toContain('add the field - files: a.ts - proof: a.spec.ts');
    const plan = JSON.parse((await documents.latestBody(KEY, 'requirements')) ?? '{}').plan;
    expect(plan).toMatchObject({ items: old.items, decision: 'approve' });
    expect(await documents.latestBody(KEY, 'plan_improve_result')).toContain('"plan":[]');
  });
});

describe('a run stored before implement results', () => {
  const IMPLEMENT_KEY = 'PROJ-471';
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  it('waiting in implement-improve with the implementation document only keeps its items and goes on to done', async () => {
    const blocks = new BlockAgentRunner({
      'implement-improve': [{ block: { implementation: [], summary: ['it holds'] } }],
    });
    flow = await createFlowHarness(IMPLEMENT_KEY, { blocks, realImplement: 'all' });
    const documents = flow.app.app.get(DocumentRepository);
    const run = await approvedRun(flow, IMPLEMENT_KEY, 'implement-improve');
    await documents.putDocument(run, 'implementation', '- changed the field parser\n- ran unit tests\n');
    expect(await documents.latestBody(IMPLEMENT_KEY, 'implementation_result')).toBeNull();

    await flow.person('resume');

    expect((await flow.app.app.get(RunRepository).findRun(IMPLEMENT_KEY))?.currentStep).toBe('done');
    const prompt = blocks.prompts.find((item) => item.step === 'implement-improve')?.prompt ?? '';
    expect(prompt).toContain('Implementation:\n- changed the field parser\n- ran unit tests');
    expect(await documents.latestBody(IMPLEMENT_KEY, 'implementation')).toBe(
      '- changed the field parser\n- ran unit tests\n',
    );
    expect(
      JSON.parse((await documents.latestBody(IMPLEMENT_KEY, 'implementation_result')) ?? '{}').implementation,
    ).toEqual(['changed the field parser', 'ran unit tests']);
  });
});

describe('a run stored before review results', () => {
  const REVIEW_KEY = 'PROJ-472';
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  it('waiting in code-review with the old documents only reviews from them and goes on to done', async () => {
    const blocks = new BlockAgentRunner();
    flow = await createFlowHarness(REVIEW_KEY, { blocks, realImplement: 'all', realReview: true });
    const documents = flow.app.app.get(DocumentRepository);
    const run = await approvedRun(flow, REVIEW_KEY, 'code-review');
    await documents.putDocument(run, 'implementation', '- changed the field parser\n');
    await documents.putDocument(run, 'handoff', '## implement\n- the parser had to match the field\n');
    await documents.putDocument(run, 'review_quality', 'Old review.\n\nsummary:\n- the parser holds\n\ndecision: ok\n');
    expect(await documents.latestBody(REVIEW_KEY, 'implementation_result')).toBeNull();
    expect(await documents.latestBody(REVIEW_KEY, 'review_quality_result')).toBeNull();

    await flow.person('resume');

    expect((await flow.app.app.get(RunRepository).findRun(REVIEW_KEY))?.currentStep).toBe('done');
    const prompt = blocks.prompts.find((item) => item.step === 'code-review-quality')?.prompt ?? '';
    expect(prompt).toContain('changed the field parser');
    expect(prompt).toContain('add the field');
    expect(prompt).toContain('the parser had to match the field');
    expect(JSON.parse((await documents.latestBody(REVIEW_KEY, 'review_quality_result')) ?? '{}')).toMatchObject({
      decision: 'ok',
    });
    expect(await documents.latestBody(REVIEW_KEY, 'review_report_result')).toContain('"whatChanged"');
  });
});
