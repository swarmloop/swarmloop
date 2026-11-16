import 'reflect-metadata';
import { CODE_REVIEWERS } from '../contract/steps';
import { DocumentRepository } from '../history/document.repository';
import { StepEventLog } from '../history/step-event.log';
import { RunRepository } from '../history/run.repository';
import { createFlowHarness } from './flow-harness';
import { BlockAgentRunner } from './result-answer';
import { remember } from './runs.spec-helpers';

const KEY = 'PROJ-480';
const LEGACY_KEY = 'PROJ-481';
const GAP = 'R9 is not covered: requirement 9';

const LIST = Array.from({ length: 9 }, (_, index) => ({ id: `R${index + 1}`, text: `requirement ${index + 1}` }));
const ITEMS = LIST.map((entry) => `do ${entry.id} - files: a.ts - proof: a.spec.ts`);
const RESEARCH = { summary: ['researched the change'], questions: [], impact: [], requirements: LIST };

const plan = (count: number) => ({
  block: {
    summary: ['planned the change'],
    plan: ITEMS.slice(0, count),
    covers: ITEMS.slice(0, count).map((_, index) => [`R${index + 1}`]),
  },
});
const REVIEW = { decision: 'ok', review: 'reviewed the change', summary: ['reviewed the change'] };
const MARKS = { ...REVIEW, requirements: LIST.map((entry) => ({ id: entry.id, status: 'met', note: 'done' })) };

const STEPS = ['research', 'plan', 'plan-improve', 'implement', ...CODE_REVIEWERS.map((name) => `code-review-${name}`)];

/** The size in characters of the first prompt of each step that the run launched. */
function firstPromptSizes(blocks: BlockAgentRunner): Record<string, number> {
  return Object.fromEntries(
    STEPS.map((step) => [step, blocks.prompts.find((item) => item.step === step)?.prompt.length ?? 0]),
  );
}

describe('a run whose input has nine requirements', () => {
  let flow: Awaited<ReturnType<typeof createFlowHarness>>;

  afterEach(async () => {
    jest.restoreAllMocks();
    await flow.close();
  });

  it('lists them, sends a plan with a gap back once, and runs to done with no person', async () => {
    const blocks = new BlockAgentRunner(
      { plan: [plan(8), plan(9)] },
      { research: RESEARCH, 'code-review-requirements': MARKS },
    );
    flow = await createFlowHarness(KEY, { blocks, realImplement: 'all', realReview: true });
    const runs = flow.app.app.get(RunRepository);
    const documents = flow.app.app.get(DocumentRepository);
    await remember(runs, documents, KEY, 'research', 'waiting');

    await flow.person('resume');

    const run = (await runs.findRun(KEY))!;
    expect(run.currentStep).toBe('done');
    expect(run.status).toBe('done');
    const stored = JSON.parse((await documents.latestBody(KEY, 'requirement_list')) ?? '[]');
    expect(stored.map((entry: { id: string }) => entry.id)).toEqual(LIST.map((entry) => entry.id));

    const planPrompts = blocks.prompts.filter((item) => item.step === 'plan');
    expect(planPrompts).toHaveLength(2);
    expect(planPrompts[1].prompt).toContain(GAP);
    const coverage = JSON.parse((await documents.latestBody(KEY, 'requirement_coverage')) ?? '[]');
    expect(coverage.map((entry: { items: string[] }) => entry.items.length)).toEqual(Array(9).fill(1));
    expect(await documents.latestBody(KEY, 'handoff')).not.toContain('coverage gap');

    for (const name of CODE_REVIEWERS) {
      const prompt = blocks.prompts.find((item) => item.step === `code-review-${name}`)?.prompt ?? '';
      expect(prompt).toContain('Requirements list');
      expect(prompt).toContain('R9: requirement 9');
      expect(prompt).toContain('covers: R9');
    }

    const events = (await flow.app.app.get(StepEventLog).page(run.id, { limit: 2000 })).events;
    const kinds = (step: string, kind: 'artifact.produced' | 'input.received') =>
      events
        .filter((event) => event.step === step && event.kind === kind)
        .map((event) => ('artifactKind' in event ? event.artifactKind : 'inputKind' in event ? event.inputKind : ''));
    expect(kinds('research', 'artifact.produced')).toContain('requirement_list');
    expect(kinds('plan', 'artifact.produced')).toContain('requirement_coverage');
    expect(kinds('implement', 'input.received')).toContain('requirement_coverage');
  });

  it('adds only the list and the covers to the first prompts, against a run with no list', async () => {
    const blocks = new BlockAgentRunner({ plan: [plan(9)] }, { research: RESEARCH, 'code-review-requirements': MARKS });
    flow = await createFlowHarness(KEY, { blocks, realImplement: 'all', realReview: true });
    const runs = flow.app.app.get(RunRepository);
    const documents = flow.app.app.get(DocumentRepository);
    await remember(runs, documents, KEY, 'research', 'waiting');
    await flow.person('resume');
    const after = firstPromptSizes(blocks);
    await flow.close();

    const legacy = new BlockAgentRunner({}, { 'code-review-requirements': REVIEW });
    flow = await createFlowHarness(LEGACY_KEY, { blocks: legacy, realImplement: 'all', realReview: true });
    await remember(
      flow.app.app.get(RunRepository),
      flow.app.app.get(DocumentRepository),
      LEGACY_KEY,
      'plan',
      'waiting',
    );
    await flow.person('resume');
    const before = firstPromptSizes(legacy);

    expect((await flow.app.app.get(RunRepository).findRun(LEGACY_KEY))?.currentStep).toBe('done');
    const listAndCovers = JSON.stringify(LIST).length + ITEMS.length * 20;
    // Research is the first step, so a run with no list never launches it; plan-improve resumes the plan's chat, which already holds the list.
    for (const step of STEPS.filter((name) => name !== 'research')) {
      expect(after[step] - before[step]).toBeGreaterThanOrEqual(step === 'plan-improve' ? 0 : 1);
      expect(after[step] - before[step]).toBeLessThan(listAndCovers + 1500);
    }
  });
});
