import { CLAUDE_LIMITS } from './claude/claude-limit';
import { classifyLimit, resetsAt, resetsIn } from './runtime-limit';

const NOW = Date.parse('2026-11-08T18:42:00Z');
const LIMIT = "You've hit your 5-hour limit · resets 9:50pm (UTC)";
const HIT = { window: '5-hour', resetsAt: '2026-11-08T21:50:00.000Z' };

const event = (text: string, isError: boolean): string =>
  JSON.stringify({ type: 'result', subtype: 'success', is_error: isError, result: text });
const classify = (finalLine: string, stderr = '') => classifyLimit(CLAUDE_LIMITS, { finalLine, stderr, now: NOW });

describe('classifyLimit', () => {
  it('reads a limit text in a result event the CLI reports as an error', () => {
    expect(classify(event(LIMIT, true))).toEqual(HIT);
  });

  it('reads a limit text printed on stderr when the final line says nothing', () => {
    expect(classify('', `warming up\n${LIMIT}\n`)).toEqual(HIT);
  });

  it('reads a limit text that is the whole final line and not JSON', () => {
    expect(classify(LIMIT)).toEqual(HIT);
  });

  it('does not take a success result that quotes a limit for a limit', () => {
    expect(classify(event(LIMIT, false))).toBeNull();
  });

  it('skips a text over 400 characters', () => {
    expect(classify(event(`${LIMIT} ${'x'.repeat(400)}`, true))).toBeNull();
  });

  it('does not match a limit that is only quoted later in the text', () => {
    expect(classify(event(`The docs say "${LIMIT}" when the window is used up.`, true))).toBeNull();
  });

  it('gives none for output that holds no limit', () => {
    expect(classify(event('Done.', true), 'a warning\n')).toBeNull();
  });
});

describe('resetsAt', () => {
  it.each([
    ['9:50pm', '2026-11-08T21:50:00.000Z'],
    ['9 PM', '2026-11-08T21:00:00.000Z'],
    ['21:50', '2026-11-08T21:50:00.000Z'],
    ['9am', '2026-11-09T09:00:00.000Z'],
    ['Nov 14th, 2026 9:50 PM', '2026-11-14T21:50:00.000Z'],
    ['Nov 14, 9am', '2026-11-14T09:00:00.000Z'],
    ['Nov 2, 9am', '2027-11-02T09:00:00.000Z'],
  ])('reads %s in UTC after the fixed now', (text, expected) => {
    expect(resetsAt(text, 'UTC', NOW)).toBe(expected);
  });

  it('gives none for a zone other than UTC', () => {
    expect(resetsAt('9:50pm', 'America/New_York', NOW)).toBeUndefined();
  });

  it('gives none for text that is no time', () => {
    expect(resetsAt('when the window ends', 'UTC', NOW)).toBeUndefined();
    expect(resetsAt(undefined, 'UTC', NOW)).toBeUndefined();
  });
});

describe('resetsIn', () => {
  it.each([
    ['3 days 5 hours 2 minutes', '2026-11-11T23:44:00.000Z'],
    ['1h 30m', '2026-11-08T20:12:00.000Z'],
    ['45s', '2026-11-08T18:42:45.000Z'],
  ])('adds %s to the fixed now', (text, expected) => {
    expect(resetsIn(text, NOW)).toBe(expected);
  });

  it('gives none for text that is no length of time', () => {
    expect(resetsIn('soon', NOW)).toBeUndefined();
    expect(resetsIn(undefined, NOW)).toBeUndefined();
  });
});
