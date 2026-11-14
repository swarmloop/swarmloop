import { ERROR_CODES } from '../../contract/error-codes';
import { needsWait, renderNeeds, storedNeeds } from './needs';

describe('needs', () => {
  it('takes the needs of the research result while the stored body is what it rendered', () => {
    const needs = [{ id: 'a', what: 'the policy: with a colon' }];
    const result = { summary: [], questions: [], impact: [], needs };

    expect(storedNeeds(renderNeeds(needs), result)).toEqual(needs);
    expect(renderNeeds([])).toBe('');
  });

  it('reads a body that is not the render of the result as it was written', () => {
    const result = { summary: [], questions: [], impact: [], needs: [{ id: 'a', what: 'old' }] };

    expect(storedNeeds('needs:\n- b: from plan\n', result)).toEqual([{ id: 'b', what: 'from plan' }]);
    expect(storedNeeds('needs:\n- b: from plan\n', null)).toEqual([{ id: 'b', what: 'from plan' }]);
  });

  it('gives none for an empty body, whatever the result holds', () => {
    const result = { summary: [], questions: [], impact: [], needs: [{ id: 'a', what: 'old' }] };

    expect(storedNeeds('', result)).toEqual([]);
  });

  it('waits at the step that asked and says what for', () => {
    const result = needsWait('t0', [
      { id: 'a', what: 'one' },
      { id: 'b', what: 'two' },
    ]);

    expect(result.route).toEqual({
      to: 'wait',
      code: ERROR_CODES.SUBTASK_WAITING,
      reason: 'waiting for a: one; waiting for b: two',
    });
  });
});
