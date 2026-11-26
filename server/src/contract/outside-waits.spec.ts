import { ERROR_CODES } from './error-codes';
import { OUTSIDE_WAITS, outsideWaitOf, outsideWaitOfRun } from './outside-waits';

describe('outsideWaitOf', () => {
  it('reads each code of the table with its next try', () => {
    for (const code of Object.keys(OUTSIDE_WAITS)) {
      expect(outsideWaitOf({ code, message: 'm' })).toEqual({ code, message: 'm', retryAt: null });
    }
    expect(outsideWaitOf({ code: ERROR_CODES.CI_NOT_STARTED, message: 'm', retryAt: 't1' })?.retryAt).toBe('t1');
    expect(outsideWaitOf({ code: ERROR_CODES.RUNTIME_LIMIT, message: 'm', resumesAt: 't2' })?.retryAt).toBe('t2');
  });

  it('reads a stored record like a thrown error', () => {
    const record = { code: 'HOST_UNAVAILABLE', message: 'down', retryAt: '2026-11-26T10:00:00.000Z' };
    expect(outsideWaitOf(record)).toEqual(record);
  });

  it('reads null for anything else', () => {
    expect(outsideWaitOf(null)).toBeNull();
    expect(outsideWaitOf('HOST_UNAVAILABLE')).toBeNull();
    expect(outsideWaitOf({ code: 'STEP_FAILED', message: 'm' })).toBeNull();
    expect(outsideWaitOf({ code: 'toString', message: 'm' })).toBeNull();
    expect(outsideWaitOf({ message: 'm' })).toBeNull();
    expect(outsideWaitOf({ code: 'HOST_UNAVAILABLE', message: 1 })).toBeNull();
  });
});

describe('outsideWaitOfRun', () => {
  it('matches on status and code', () => {
    expect(outsideWaitOfRun('blocked', 'DISK_LOW')).toEqual({ status: 'blocked', end: 'disk' });
    expect(outsideWaitOfRun('waiting', 'DISK_LOW')).toBeNull();
    expect(outsideWaitOfRun('waiting', 'GIT_AUTH')).toEqual({ status: 'waiting', end: 'connection' });
    expect(outsideWaitOfRun('blocked', 'GIT_AUTH')).toBeNull();
  });

  it('reads null for an unknown code, null or undefined', () => {
    expect(outsideWaitOfRun('waiting', 'toString')).toBeNull();
    expect(outsideWaitOfRun('waiting', null)).toBeNull();
    expect(outsideWaitOfRun('waiting', undefined)).toBeNull();
  });
});
