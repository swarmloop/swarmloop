import 'reflect-metadata';
import { RunQueriesService } from '../api/run-queries.service';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { handoffText } from '../steps/shared/handoff';
import { SubtaskOps } from '../steps/shared/subtask-ops';
import { createFlowHarness } from './flow-harness';
import { BlockAgentRunner, DEFAULT_RESEARCH } from './result-answer';
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

    await flow.person('resume');

    expect((await runs.findRun(KEY))?.status).toBe('done');
    const stored = (await documents.latestBody(KEY, 'handoff')) ?? '';
    expect(JSON.parse(stored).slice(0, 2)).toEqual([
      { step: 'requirements', body: '- the form saves' },
      { step: 'prepare', body: '- prepared the repository' },
    ]);
    expect(handoffText(stored)).toContain(old.trimEnd());
    const prompt = blocks.prompts.find((item) => item.step === 'research')?.prompt ?? '';
    expect(prompt).toContain('## requirements\n- the form saves\n\n## prepare\n- prepared the repository\n');
  });
});
