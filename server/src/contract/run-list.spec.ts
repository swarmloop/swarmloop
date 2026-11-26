import { DONE_STATES } from './run-list';

describe('DONE_STATES', () => {
  it('lists every state in which a run has ended', () => {
    expect([...DONE_STATES].sort()).toEqual(['closed', 'done', 'merged', 'skipped']);
  });
});
