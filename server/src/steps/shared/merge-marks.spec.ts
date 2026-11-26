import type { DocumentRepository } from '../../history/document.repository';
import { ARTIFACTS } from '../contract/artifacts';
import { MergeMarks } from './merge-marks';

/** A run whose only document is a plan with the given items. */
function marks(items: string[]): MergeMarks {
  const body = ARTIFACTS.planResult.format({
    summary: [],
    plan: items,
    questions: [],
    contract: [],
    tasks: [],
    keep: [],
  });
  const documents = {
    latestBody: async (_key: string, kind: string) => (kind === ARTIFACTS.planResult.kind ? body : null),
    latestDocument: async (_key: string, kind: string) =>
      kind === ARTIFACTS.planResult.kind ? { id: 1, kind, body } : null,
  } as unknown as DocumentRepository;
  return new MergeMarks(documents);
}

describe('MergeMarks.outsideOwn', () => {
  const changed = ['a.ts', 'b.spec.ts', 'src/x.ts'];

  it("names the files outside a task's listed files", async () => {
    expect(await marks(['Do it - proof: x']).outsideOwn('K', { files: ['a.ts'] }, changed)).toEqual([
      'b.spec.ts',
      'src/x.ts',
    ]);
  });

  it("reads the plan's files for a run without listed files", async () => {
    const plan = marks(['Do it - files: a.ts, b.spec.ts - proof: b.spec.ts']);
    expect(await plan.outsideOwn('K', { files: [] }, changed)).toEqual(['src/x.ts']);
  });

  it('counts a folder entry as inside', async () => {
    expect(await marks(['Do it - proof: x']).outsideOwn('K', { files: ['src/', 'a.ts'] }, changed)).toEqual([
      'b.spec.ts',
    ]);
  });

  it('gives none when nothing is planned', async () => {
    expect(await marks(['Do it - proof: b.spec.ts']).outsideOwn('K', { files: [] }, changed)).toEqual([]);
  });
});
