import { ClaudeRuntime } from './claude.runtime';

const NOW = Date.parse('2026-11-08T18:42:00Z');
const runtime = new ClaudeRuntime();
const result = (text: string): string =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: text });
const classify = (finalLine: string, stderr = '') => runtime.classifyLimit({ finalLine, stderr, now: NOW });

describe('Claude limit texts', () => {
  it('reads the limit that stopped run-mw85iykj: window and reset in UTC', () => {
    expect(classify(result("You've hit your 5-hour limit · resets 9:50pm (UTC)"))).toEqual({
      window: '5-hour',
      resetsAt: '2026-11-08T21:50:00.000Z',
    });
  });

  it('takes the next day when the clock time has passed', () => {
    expect(classify(result("You've hit your 5-hour limit · resets 9:50am (UTC)"))?.resetsAt).toBe(
      '2026-11-09T09:50:00.000Z',
    );
  });

  it('reads a weekly limit with a date', () => {
    expect(classify(result("You've hit your weekly limit · resets Nov 14, 9am (UTC)"))).toEqual({
      window: 'weekly',
      resetsAt: '2026-11-14T09:00:00.000Z',
    });
  });

  it('reads the older wording and a limit without a window', () => {
    expect(classify(result('5-hour limit reached ∙ resets 11pm'))).toEqual({
      window: '5-hour',
      resetsAt: '2026-11-08T23:00:00.000Z',
    });
    expect(classify(result("You've hit your limit"))).toEqual({});
  });

  it('gives no reset when the zone is not UTC or the text has no time', () => {
    expect(
      classify(result("You've hit your 5-hour limit · resets 9:50pm (America/New_York)"))?.resetsAt,
    ).toBeUndefined();
  });

  it('reads the line on stderr', () => {
    expect(classify('', "You've hit your 5-hour limit · resets 9:50pm (UTC)\n")?.window).toBe('5-hour');
  });

  it('does not take the limit text of a successful answer for a limit', () => {
    const answer = JSON.stringify({
      type: 'result',
      is_error: false,
      result: "You've hit your 5-hour limit · resets Jan 1, 2099 9am (UTC)",
    });
    expect(classify(answer)).toBeNull();
  });

  it.each([
    ['an auth error', 'Invalid API key · Please run /login'],
    ['an expired login', 'OAuth token has expired. Please obtain a new token or refresh your existing token.'],
    ['a billing error', 'Credit balance is too low'],
    ['a network error', 'API Error: Unable to connect to API (ENOTFOUND api.anthropic.com)'],
    ['a full context', 'Prompt is too long'],
    [
      'an answer that quotes a limit',
      "decision: ok\nThe CLI printed: You've hit your 5-hour limit · resets 9:50pm (UTC)",
    ],
  ])('does not take %s for a limit', (_name, text) => {
    expect(classify(result(text), text)).toBeNull();
  });
});
