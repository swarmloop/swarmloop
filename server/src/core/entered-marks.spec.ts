import { enteredBefore, markedInterval, markEntered } from './entered-marks';

describe('entered marks', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('picks the last mark at or before a time', () => {
    jest.setSystemTime(1_000_000);
    markEntered('first');
    jest.setSystemTime(1_005_000);
    markEntered('second');
    jest.setSystemTime(1_009_000);
    markEntered('third');
    expect(enteredBefore(1_005_000)).toBe('second');
    expect(enteredBefore(1_008_999)).toBe('second');
    expect(enteredBefore(1_000_000)).toBe('first');
  });

  it('gives null when no mark is that old', () => {
    jest.setSystemTime(2_000_000);
    markEntered('only');
    for (let i = 0; i < 32; i += 1) markEntered(`fill ${i}`);
    expect(enteredBefore(1_999_999)).toBeNull();
  });

  it('keeps only the last 32 marks', () => {
    jest.setSystemTime(3_000_000);
    markEntered('oldest');
    for (let i = 0; i < 32; i += 1) markEntered(`later ${i}`);
    expect(enteredBefore(3_000_000)).toBe('later 31');
    jest.setSystemTime(3_000_100);
    expect(enteredBefore(3_000_100)).toBe('later 31');
  });

  it('marks before it calls the callback', () => {
    jest.setSystemTime(4_000_000);
    let seen: string | null = null;
    const timer = markedInterval(
      'tick job',
      () => {
        seen = enteredBefore(Date.now());
      },
      1000,
    );
    jest.advanceTimersByTime(1000);
    clearInterval(timer);
    expect(seen).toBe('tick job');
  });

  it('does not hold the process', () => {
    const timer = markedInterval('quiet', () => undefined, 1000);
    expect(timer.hasRef()).toBe(false);
    clearInterval(timer);
  });
});
