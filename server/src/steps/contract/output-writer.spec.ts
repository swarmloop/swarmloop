import { ARTIFACTS } from './artifacts';
import { outputDrafts } from './output-writer';

describe('output writer', () => {
  it('turns a listed output into a draft through its codec', () => {
    expect(
      outputDrafts(
        'research',
        [ARTIFACTS.questions, ARTIFACTS.repos],
        [{ artifact: ARTIFACTS.repos, value: ['a', 'b'] }],
      ),
    ).toEqual([{ kind: 'repos', fileName: '', body: 'a\nb\n' }]);
  });

  it('keeps the order of the outputs', () => {
    const drafts = outputDrafts(
      'pipeline',
      [ARTIFACTS.pipelineLog, ARTIFACTS.return],
      [
        { artifact: ARTIFACTS.return, value: 'notes\n' },
        { artifact: ARTIFACTS.pipelineLog, value: 'result: fail\n' },
      ],
    );
    expect(drafts.map((draft) => draft.kind)).toEqual(['return', 'pipeline_log']);
  });

  it('throws for an artifact the step did not list', () => {
    expect(() => outputDrafts('branch', [], [{ artifact: ARTIFACTS.commit, value: 'a.ts\n' }])).toThrow(
      'branch may not write commit',
    );
  });
});
