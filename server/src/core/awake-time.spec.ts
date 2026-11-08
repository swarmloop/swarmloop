import { AwakeTime } from './awake-time';
import { FakeClock } from './fake-clock.spec-helpers';

describe('AwakeTime', () => {
  it('counts awake time as elapsed and idle', () => {
    const clock = new FakeClock();
    const time = new AwakeTime(clock, 5_000);
    clock.advance(4_000);
    expect(time.elapsedMs()).toBe(4_000);
    time.touch();
    clock.advance(3_000);
    expect(time.idleMs()).toBe(3_000);
    expect(time.elapsedMs()).toBe(7_000);
  });

  it('cuts a gap over three intervals out of elapsed and idle time and reports it once', () => {
    const clock = new FakeClock();
    const gaps: number[] = [];
    const time = new AwakeTime(clock, 5_000, (gap) => gaps.push(gap));
    for (let sample = 0; sample < 120; sample += 1) {
      clock.advance(5_000);
      time.observe();
    }
    expect(time.elapsedMs()).toBe(10 * 60_000);
    clock.advance(40 * 60_000);
    expect(time.elapsedMs()).toBe(10 * 60_000);
    expect(time.idleMs()).toBe(10 * 60_000);
    expect(time.elapsedMs()).toBe(10 * 60_000);
    expect(gaps).toEqual([40 * 60_000]);
  });

  it('does not take a gap of exactly three intervals for a suspension', () => {
    const clock = new FakeClock();
    const gaps: number[] = [];
    const time = new AwakeTime(clock, 5_000, (gap) => gaps.push(gap));
    clock.advance(15_000);
    expect(time.elapsedMs()).toBe(15_000);
    expect(gaps).toEqual([]);
  });

  it('follows the interval it is given', () => {
    const clock = new FakeClock();
    const gaps: number[] = [];
    const time = new AwakeTime(clock, 20_000, (gap) => gaps.push(gap));
    clock.advance(50_000);
    expect(time.elapsedMs()).toBe(50_000);
    expect(gaps).toEqual([]);
  });

  it('does not take the length of an operation for a suspension', async () => {
    const clock = new FakeClock();
    const gaps: number[] = [];
    const time = new AwakeTime(clock, 5_000, (gap) => gaps.push(gap));
    await time.run(() => {
      clock.advance(120_000);
      return Promise.resolve();
    });
    clock.advance(1_000);
    expect(time.elapsedMs()).toBe(121_000);
    expect(gaps).toEqual([]);
  });
});
