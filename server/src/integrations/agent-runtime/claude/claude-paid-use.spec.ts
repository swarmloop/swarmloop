import { readFileSync } from 'fs';
import { join } from 'path';
import { claudePaidUse } from './claude-paid-use';

const RECORDED = readFileSync(join(__dirname, 'claude-stream.recorded.jsonl'), 'utf8').trim().split('\n');
const RATE_LIMIT_EVENTS = RECORDED.filter((line) => line.includes('"rate_limit_event"'));

/** A rate limit event of a real Claude launch, taken from this server's own launch while paid use was not in use. */
const REAL = RATE_LIMIT_EVENTS.find((line) => line.includes('"isUsingOverage":false')) ?? '';
/**
 * Derived from the real line, with only `isUsingOverage` set to true: no real paid-use line exists yet.
 * Replace it with a real line when one is recorded.
 */
const DERIVED = RATE_LIMIT_EVENTS.find((line) => line.includes('"isUsingOverage":true')) ?? '';

/** The real rate limit event with its `isUsingOverage` and window changed. */
function overageEvent(patch: { isUsingOverage: boolean; rateLimitType?: string }): string {
  const event = JSON.parse(REAL) as { rate_limit_info: Record<string, unknown> };
  return JSON.stringify({ ...event, rate_limit_info: { ...event.rate_limit_info, ...patch } });
}

describe('claudePaidUse', () => {
  it('finds no paid use in the real line and the rest of the recorded launch', () => {
    expect(RECORDED).toHaveLength(5);
    expect(RECORDED.filter((line) => line !== DERIVED).map(claudePaidUse)).toEqual([null, null, null, null]);
  });

  it('keeps the derived line the real line with only isUsingOverage set to true', () => {
    expect(JSON.parse(DERIVED)).toEqual(JSON.parse(overageEvent({ isUsingOverage: true })));
  });

  it('reads the window and the reset of the derived line that is using overage', () => {
    expect(claudePaidUse(DERIVED)).toEqual({ window: 'weekly', resetsAt: '2026-12-03T21:00:00.000Z' });
  });

  it('names the 5-hour window for a five-hour event', () => {
    expect(claudePaidUse(overageEvent({ isUsingOverage: true, rateLimitType: 'five_hour' }))).toEqual({
      window: '5-hour',
      resetsAt: '2026-12-03T21:00:00.000Z',
    });
  });

  it('gives no window for a window it does not know', () => {
    expect(claudePaidUse(overageEvent({ isUsingOverage: true, rateLimitType: 'monthly' }))).toMatchObject({
      resetsAt: expect.any(String),
    });
    expect(claudePaidUse(overageEvent({ isUsingOverage: true, rateLimitType: 'monthly' }))?.window).toBeUndefined();
  });

  it.each(['constructor', '__proto__', 'toString'])('gives no window for the inherited key %s', (rateLimitType) => {
    const hit = claudePaidUse(overageEvent({ isUsingOverage: true, rateLimitType }));
    expect(hit).toMatchObject({ resetsAt: expect.any(String) });
    expect(hit?.window).toBeUndefined();
  });

  it('gives null for a line that is no JSON', () => {
    expect(claudePaidUse('process started')).toBeNull();
    expect(claudePaidUse('{"type":"rate_limit_event",')).toBeNull();
  });
});
