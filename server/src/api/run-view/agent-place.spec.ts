import type { FlowView } from '../../contract/api';
import { runPlace, withPlaceChips } from './agent-place';

const text = 'Waiting for a free agent place (4 of 4 busy)';

describe('runPlace', () => {
  it('gives the words only when an agent of the run waits and none of its agents runs', () => {
    expect(runPlace({ steps: ['implement'], running: 0, text })).toBe(text);
    expect(runPlace({ steps: ['code-review-a'], running: 4, text })).toBeUndefined();
    expect(runPlace({ steps: [], running: 0, text })).toBeUndefined();
  });
});

describe('withPlaceChips', () => {
  const chip = (name: string, status: string) => ({ name, status, current: false, attempts: 1 });
  const phases: FlowView['phases'] = [
    { phase: 'code-review', steps: [chip('code-review-a', 'running'), chip('code-review-b', 'running')] },
  ];

  it('marks only the chip of the waiting step as waiting, with the words as its note', () => {
    const [phase] = withPlaceChips(phases, { steps: ['code-review-b'], running: 1, text });
    expect(phase?.steps).toEqual([
      chip('code-review-a', 'running'),
      { ...chip('code-review-b', 'waiting'), note: text },
    ]);
  });

  it('leaves the chips as they are when no step waits', () => {
    expect(withPlaceChips(phases, { steps: [], running: 2, text })).toBe(phases);
  });
});
