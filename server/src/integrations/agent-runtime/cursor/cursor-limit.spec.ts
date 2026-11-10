import { CursorRuntime } from './cursor.runtime';

const NOW = Date.parse('2026-11-08T18:42:00Z');
const runtime = new CursorRuntime();
const result = (text: string): string => JSON.stringify({ type: 'result', is_error: true, result: text });
const classify = (finalLine: string, stderr = '') => runtime.classifyLimit({ finalLine, stderr, now: NOW });

describe('Cursor limit texts', () => {
  it('reads a usage limit with and without a reset', () => {
    expect(classify(result("You've hit your usage limit. Your limit resets on Nov 14, 9am."))).toEqual({
      window: 'usage',
      resetsAt: '2026-11-14T09:00:00.000Z',
    });
    expect(classify(result("You've hit your usage limit"))).toEqual({ window: 'usage' });
  });

  it('reads a rate limit', () => {
    expect(classify(result('Rate limit exceeded. Try again in 30 seconds.'))).toEqual({
      window: 'rate',
      resetsAt: '2026-11-08T18:42:30.000Z',
    });
  });

  it('reads an exhausted quota from stderr', () => {
    expect(classify('', 'ConnectError: [resource_exhausted] Error\n')).toEqual({ window: 'quota' });
  });

  it.each([
    ['an auth error', 'Authentication required. Please run agent login or set CURSOR_API_KEY.'],
    ['a billing error', 'Payment required: add a payment method to continue.'],
    ['a network error', 'ConnectError: [unavailable] fetch failed'],
    ['a full context', 'The conversation is too long for this model.'],
  ])('does not take %s for a limit', (_name, text) => {
    expect(classify(result(text), text)).toBeNull();
  });
});
