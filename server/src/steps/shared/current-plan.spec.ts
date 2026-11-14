import type { DocumentRepository } from '../../history/document.repository';
import { ARTIFACTS } from '../contract/artifacts';
import { planFields, withPlan } from '../plan/plan-record';
import { currentPlan } from './current-plan';

const SPLIT = {
  summary: [],
  plan: [],
  questions: [],
  contract: ['rule'],
  keep: [],
  tasks: [{ id: 'a', title: 'Add it', depends: [], files: ['a.ts', 'b.ts'], proof: 'a.spec.ts', description: 'Adds.' }],
};

/** The documents of one run in the order they were written. */
function documentsOf(...written: [string, string][]): DocumentRepository {
  const stored = written.map(([kind, body], index) => ({ id: index + 1, kind, body }));
  const latest = (kind: string) => [...stored].reverse().find((item) => item.kind === kind) ?? null;
  return {
    latestBody: async (_key: string, kind: string) => latest(kind)?.body ?? null,
    latestDocument: async (_key: string, kind: string) => latest(kind),
  } as unknown as DocumentRepository;
}

const requirements = (items: string[], decision: 'approve' | 'revise' | null = null): [string, string] => [
  'requirements',
  withPlan('{"prompt":"p"}\n', { name: 'Field', overview: 'Ship it.', items, decision }),
];
const planned = (items: string[]): [string, string] => [
  ARTIFACTS.planResult.kind,
  ARTIFACTS.planResult.format({ summary: [], plan: items, questions: [], contract: [], tasks: [], keep: [] }),
];
const improved = (items: string[]): [string, string] => [
  ARTIFACTS.planImproveResult.kind,
  ARTIFACTS.planImproveResult.format({ summary: [], plan: items, contract: [], tasks: [], keep: [] }),
];

const implemented = (plan?: string[]): [string, string] => [
  ARTIFACTS.implementationResult.kind,
  ARTIFACTS.implementationResult.format({ implementation: ['did it'], summary: [], plan }),
];
const implementImproved = (plan?: string[]): [string, string] => [
  ARTIFACTS.implementationImproveResult.kind,
  ARTIFACTS.implementationImproveResult.format({ summary: [], plan }),
];

describe('currentPlan', () => {
  it('reads the checklist an implement step corrected, newest of the four results first', async () => {
    const first = documentsOf(
      planned(['plan']),
      improved(['improved']),
      implemented(['implemented']),
      requirements(['r']),
    );
    expect((await currentPlan(first, 'K'))?.items).toEqual(['implemented']);
    const second = documentsOf(planned(['plan']), implemented(['implemented']), implementImproved(['reviewed']));
    expect((await currentPlan(second, 'K'))?.items).toEqual(['reviewed']);
  });

  it('keeps a correction when the later results carry the checklist in force', async () => {
    const documents = documentsOf(planned(['plan']), implemented(['corrected']), implementImproved(['corrected']));
    expect((await currentPlan(documents, 'K'))?.items).toEqual(['corrected']);
  });

  it('skips an implement result with no corrected checklist', async () => {
    const documents = documentsOf(planned(['plan']), implemented(['x']), implementImproved(), implemented([]));
    expect((await currentPlan(documents, 'K'))?.items).toEqual(['plan']);
  });

  it('reads the plan inside the requirements record for a run with no result', async () => {
    expect(await currentPlan(documentsOf(requirements(['old item'])), 'K')).toEqual({
      name: 'Field',
      overview: 'Ship it.',
      items: ['old item'],
      decision: null,
    });
  });

  it('reads the checklist of the plan result, with the name, overview and decision of the record', async () => {
    const documents = documentsOf(planned(['from the result']), requirements(['from the record'], 'revise'));
    expect(await currentPlan(documents, 'K')).toEqual({
      name: 'Field',
      overview: 'Ship it.',
      items: ['from the result'],
      decision: 'revise',
    });
  });

  it('prefers the newest result, so plan-improve beats the plan before it and a replayed plan beats plan-improve', async () => {
    const first = documentsOf(planned(['plan']), improved(['improved']), requirements(['record']));
    expect((await currentPlan(first, 'K'))?.items).toEqual(['improved']);
    const replayed = documentsOf(improved(['improved']), planned(['replanned']), requirements(['record']));
    expect((await currentPlan(replayed, 'K'))?.items).toEqual(['replanned']);
  });

  it('keeps the plan before it when plan-improve sent an empty plan', async () => {
    const documents = documentsOf(planned(['plan']), improved([]), requirements(['record']));
    expect((await currentPlan(documents, 'K'))?.items).toEqual(['plan']);
  });

  it('writes the items of a split result from its tasks', async () => {
    const documents = documentsOf(
      [ARTIFACTS.planResult.kind, ARTIFACTS.planResult.format(SPLIT)],
      requirements(['record']),
    );
    expect((await currentPlan(documents, 'K'))?.items).toEqual(['Add it - files: a.ts, b.ts - proof: a.spec.ts']);
  });

  it('gives null for a run with no plan', async () => {
    expect(await currentPlan(documentsOf(['requirements', '{"prompt":"p"}\n']), 'K')).toBeNull();
    expect(planFields([]).items).toEqual([]);
  });
});
