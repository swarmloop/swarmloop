import { readFileSync } from 'fs';
import { join } from 'path';
import { claudePaidUse } from './claude-paid-use';

const RECORDED = readFileSync(join(__dirname, 'claude-stream.recorded.jsonl'), 'utf8').trim().split('\n');
const EVENT = RECORDED.find((line) => line.includes('"rate_limit_event"')) ?? '';

/** The recorded rate limit event with its `isUsingOverage` and window changed. */
function overageEvent(patch: { isUsingOverage: boolean; rateLimitType?: string }): string {
  const event = JSON.parse(EVENT) as { rate_limit_info: Record<string, unknown> };
  return JSON.stringify({ ...event, rate_limit_info: { ...event.rate_limit_info, ...patch } });
}

describe('claudePaidUse', () => {
  it('finds no paid use in a recorded launch that stayed on the plan', () => {
    expect(RECORDED).toHaveLength(4);
    expect(RECORDED.map(claudePaidUse)).toEqual([null, null, null, null]);
  });

  it('reads the 5-hour window and the reset of a rate limit event that is using overage', () => {
    const resetsAt = (JSON.parse(EVENT) as { rate_limit_info: { resetsAt: number } }).rate_limit_info.resetsAt;
    expect(claudePaidUse(overageEvent({ isUsingOverage: true }))).toEqual({
      window: '5-hour',
      resetsAt: new Date(resetsAt * 1000).toISOString(),
    });
  });

  it('names the weekly window for a seven-day event', () => {
    expect(claudePaidUse(overageEvent({ isUsingOverage: true, rateLimitType: 'seven_day' }))?.window).toBe('weekly');
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
