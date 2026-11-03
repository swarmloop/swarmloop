import { FakeClock } from './fake-clock.spec-helpers';
import { SystemClock } from './clock';

describe('SystemClock', () => {
  it('reads the current time as an ISO string', () => {
    const before = Date.now();
    const iso = new SystemClock().iso();
    const after = Date.now();
    expect(Date.parse(iso)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(iso)).toBeLessThanOrEqual(after);
    expect(iso).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  });
});

describe('FakeClock', () => {
  it('stands still until advanced', () => {
    const clock = new FakeClock(1_000);
    expect(clock.now()).toBe(1_000);
    expect(clock.now()).toBe(1_000);
  });

  it('moves forward on advance', () => {
    const clock = new FakeClock(1_000);
    clock.advance(500);
    expect(clock.now()).toBe(1_500);
    expect(clock.iso()).toBe(new Date(1_500).toISOString());
  });
});
