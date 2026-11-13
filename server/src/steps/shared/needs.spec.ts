import { ERROR_CODES } from '../../contract/error-codes';
import { needsWait, parseNeeds, renderNeeds } from './needs';

describe('needs', () => {
  it('reads one need per line and drops a malformed line', () => {
    const text = [
      'summary:',
      '- chose x',
      '',
      'needs:',
      '- http-retry: the retry policy',
      '- no colon here',
      '- `reasons-core`: codes',
    ].join('\n');

    expect(parseNeeds(text)).toEqual([
      { id: 'http-retry', what: 'the retry policy' },
      { id: 'reasons-core', what: 'codes' },
    ]);
  });

  it('gives none when the section is absent or says none', () => {
    expect(parseNeeds('summary:\n- done')).toEqual([]);
    expect(parseNeeds('needs:\n- none')).toEqual([]);
  });

  it('reads back what it renders', () => {
    const needs = [{ id: 'a', what: 'the policy' }];

    expect(parseNeeds(renderNeeds(needs))).toEqual(needs);
    expect(renderNeeds([])).toBe('');
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
