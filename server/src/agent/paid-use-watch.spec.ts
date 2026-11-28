import type { AgentRuntime } from '../integrations/agent-runtime/agent-runtime';
import type { UserSettingRepository } from '../history/user-setting.repository';
import { runtimeFor } from '../integrations/agent-runtime/agent-runtime.registry';
import { PaidUseWatch } from './paid-use-watch';

const OVER = (resetsAt: number): string =>
  JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: { isUsingOverage: true, rateLimitType: 'five_hour', resetsAt },
  });
const CLAUDE = runtimeFor('claude');

describe('PaidUseWatch', () => {
  it('keeps the first paid-use line and is not replaced by a later one', () => {
    const watch = new PaidUseWatch(CLAUDE, undefined);
    watch.note('{"type":"assistant"}');
    expect(watch.hit()).toBeNull();
    watch.note(OVER(1795886400));
    watch.note(OVER(1795890000));
    expect(watch.hit()).toEqual({ window: '5-hour', resetsAt: '2026-11-28T17:20:00.000Z' });
  });

  it('gives no hit for a person who allowed paid use', () => {
    const watch = new PaidUseWatch(CLAUDE, true);
    watch.note(OVER(1795886400));
    expect(watch.hit()).toBeNull();
  });

  it('reads a hit for a person who stored false', () => {
    const watch = new PaidUseWatch(CLAUDE, false);
    watch.note(OVER(1795886400));
    expect(watch.hit()).not.toBeNull();
  });

  it('does not ask a runtime that cannot see paid use, whatever is stored', () => {
    const blind = { readsPaidUse: false, paidUseLimit: () => ({ window: 'x' }) } as unknown as AgentRuntime;
    const watch = new PaidUseWatch(blind, undefined);
    watch.note('any line');
    expect(watch.hit()).toBeNull();
  });

  it('gives the limit only for a launch that was killed for paid use', () => {
    const watch = new PaidUseWatch(CLAUDE, undefined);
    watch.note(OVER(1795886400));
    expect(watch.endedOn('paid use')).toEqual({ window: '5-hour', resetsAt: '2026-11-28T17:20:00.000Z' });
    expect(watch.endedOn('time')).toBeNull();
    expect(watch.endedOn(null)).toBeNull();
  });

  it("opens with the paid-use choice of the person whose credential the launch uses, and off for the server's own", async () => {
    const settings = { read: jest.fn().mockResolvedValue({ paysPastLimit: true }) } as unknown as UserSettingRepository;
    const own = await PaidUseWatch.open(CLAUDE, settings, 'ada');
    own.note(OVER(1795886400));
    expect(own.hit()).toBeNull();
    const server = await PaidUseWatch.open(CLAUDE, settings, null);
    server.note(OVER(1795886400));
    expect(server.hit()).not.toBeNull();
  });
});
