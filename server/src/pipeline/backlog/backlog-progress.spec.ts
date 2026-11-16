import { backlogProgress } from './backlog-progress';

const milestones = [{ id: 1, number: 1, status: 'active' as const }];

function req(ref: string, status: 'open' | 'ready' | 'closed' = 'open') {
  return { ref, milestoneId: 1, status };
}

describe('backlogProgress', () => {
  it('readies a requirement whose covering tasks are all merged or skipped with one merged, and its milestone', () => {
    const tasks = [
      { covers: ['M1.R1'], status: 'merged' as const },
      { covers: ['M1.R1'], status: 'skipped' as const },
    ];
    expect(backlogProgress([req('M1.R1')], milestones, tasks)).toEqual({
      requirements: ['M1.R1'],
      milestones: [1],
    });
  });

  it('keeps a requirement open while a covering task is unfinished, only skipped, or missing', () => {
    const tasks = [
      { covers: ['M1.R1'], status: 'merged' as const },
      { covers: ['M1.R1'], status: 'running' as const },
      { covers: ['M1.R2'], status: 'skipped' as const },
    ];
    const result = backlogProgress([req('M1.R1'), req('M1.R2'), req('M1.R3')], milestones, tasks);
    expect(result).toEqual({ requirements: [], milestones: [] });
  });

  it('does not touch a closed requirement and counts a stored ready one', () => {
    const tasks = [{ covers: ['M1.R2'], status: 'merged' as const }];
    const result = backlogProgress([req('M1.R1', 'closed'), req('M1.R2', 'ready')], milestones, tasks);
    expect(result).toEqual({ requirements: ['M1.R2'], milestones: [1] });
  });

  it('does not ready a milestone with no requirement, one that is not active, or one with an open requirement', () => {
    expect(backlogProgress([], milestones, [])).toEqual({ requirements: [], milestones: [] });
    const tasks = [{ covers: ['M1.R1'], status: 'merged' as const }];
    expect(backlogProgress([req('M1.R1')], [{ id: 1, number: 1, status: 'proposed' }], tasks).milestones).toEqual([]);
    expect(backlogProgress([req('M1.R1'), req('M1.R2')], milestones, tasks).milestones).toEqual([]);
  });
});
