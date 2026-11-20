import { ERROR_CODES } from './error-codes';
import { ETA_MIN_MS, etaPhase, etaWords, nextTryAt } from './eta';
import type { EtaPhase, RunKind } from './eta';
import { NEEDS_ANSWERS, REASON } from './run-state';
import type { StateReason } from './run-state';

const MIN = 60_000;
const reason = (code: string, extra: Partial<StateReason> = {}): StateReason => ({ code, message: code, ...extra });

describe('etaPhase', () => {
  it('reads a run that needs a person or is stopped as person', () => {
    expect(etaPhase('blocked', reason(NEEDS_ANSWERS))).toBe('person');
    expect(etaPhase('stopped', reason(REASON.stopped))).toBe('person');
  });

  it('reads a wait with a next try as timed', () => {
    const limit = { runtime: 'agent', resumesAt: '2026-11-19T20:00:00Z' };
    expect(etaPhase('waiting', reason(ERROR_CODES.RUNTIME_LIMIT, { limit }))).toBe('timed');
    expect(etaPhase('waiting', reason(ERROR_CODES.HOST_UNAVAILABLE, { retryAt: '2026-11-19T20:00:00Z' }))).toBe(
      'timed',
    );
  });

  it('reads a run that moves by itself as working', () => {
    expect(etaPhase('running', reason(REASON.agentPlace))).toBe('working');
    expect(etaPhase('running', reason('SUBTASKS_RUNNING'))).toBe('working');
  });

  it('reads a finished run as ended', () => {
    const ended: EtaPhase = 'ended';
    expect(etaPhase('done', null)).toBe(ended);
    expect(etaPhase('merged', null)).toBe(ended);
  });

  it('takes the next try from retryAt, then from the limit', () => {
    expect(nextTryAt(reason('X', { retryAt: 'a', limit: { runtime: 'r', resumesAt: 'b' } }))).toBe('a');
    expect(nextTryAt(reason('X', { limit: { runtime: 'r', resumesAt: 'b' } }))).toBe('b');
    expect(nextTryAt(null)).toBeNull();
  });
});

describe('etaWords', () => {
  const time = (iso: string): string => iso.slice(11, 16);

  it('reads 25 minutes with the time it is done', () => {
    expect(etaWords({ leftMs: 25 * MIN, doneAt: '2026-11-19T19:40:00Z' }, time)).toEqual({
      text: '~25m left',
      tip: 'done around 19:40 · rough estimate',
    });
  });

  it('rounds to 15 minutes from an hour', () => {
    expect(etaWords({ leftMs: 130 * MIN, doneAt: '2026-11-19T19:40:00Z' }, time).text).toBe('~2h 15m left');
    expect(etaWords({ leftMs: 120 * MIN, doneAt: '2026-11-19T19:40:00Z' }, time).text).toBe('~2h left');
  });

  it('never shows seconds for a tiny remainder', () => {
    const { text } = etaWords({ leftMs: 20_000, doneAt: '2026-11-19T19:40:00Z' }, time);
    expect(text).toBe('~5m left');
    expect(ETA_MIN_MS).toBe(MIN);
  });

  it.each<RunKind>(['plain', 'epic', 'subtask'])('reads a %s run the same way', () => {
    expect(etaWords({ leftMs: 25 * MIN, doneAt: '2026-11-19T19:40:00Z' }, time).text).toBe('~25m left');
  });

  it('reads no estimate as waits for you', () => {
    expect(etaWords({ leftMs: null, doneAt: null }, time)).toEqual({ text: 'waits for you', tip: '' });
  });
});
