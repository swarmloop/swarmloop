import { agentPlaceText } from './agent-place';

describe('agentPlaceText', () => {
  it('says how many agent places are busy', () => {
    expect(agentPlaceText(4, 4)).toBe('Waiting for a free agent place (4 of 4 busy)');
  });
});
