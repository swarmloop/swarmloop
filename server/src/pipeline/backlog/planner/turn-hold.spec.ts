import type { BacklogTurnRecord } from '../../../history/backlog-writers';
import { failedKeys, holdsBacklog, resumeTarget, waitsForTry } from './turn-hold';

function turn(turnKey: string, status: BacklogTurnRecord['status'], reason = '', nextTryAt: string | null = null) {
  return { backlogId: 1, turnKey, status, reason, nextTryAt, createdAt: '2026-11-22T10:00:00Z' };
}

const TRY = '2026-11-22T12:00:00Z';

describe('turn hold', () => {
  it('holds a backlog whose last turn failed, and makes that turn the Resume target', () => {
    const turns = [turn('a', 'done'), turn('b', 'failed', 'broke')];
    expect(holdsBacklog(turns)).toBe(true);
    expect(resumeTarget(turns)?.turnKey).toBe('b');
  });

  it('holds nothing when a turn followed the failed one, and leaves nothing to Resume', () => {
    const turns = [turn('a', 'failed', 'broke'), turn('b', 'done')];
    expect(holdsBacklog(turns)).toBe(false);
    expect(resumeTarget(turns)).toBeNull();
    expect(failedKeys(turns)).toEqual(['a']);
  });

  it.each([
    ['waiting', turn('a', 'waiting', 'limit', TRY)],
    ['applied with a next try', turn('a', 'applied', 'host down', TRY)],
  ])('holds a backlog whose last turn is %s, and has no Resume target', (_name, last) => {
    expect(holdsBacklog([last])).toBe(true);
    expect(waitsForTry(last)).toBe(true);
    expect(resumeTarget([last])).toBeNull();
  });

  it('makes an older applied turn with a reason and no next try the target when the last turn is done', () => {
    const turns = [turn('a', 'applied', 'sending failed'), turn('b', 'done')];
    expect(holdsBacklog(turns)).toBe(false);
    expect(resumeTarget(turns)?.turnKey).toBe('a');
  });

  it('does not wait for a try on a done or a failed turn, and holds nothing without turns', () => {
    expect(waitsForTry(turn('a', 'done'))).toBe(false);
    expect(waitsForTry(turn('a', 'failed', 'broke'))).toBe(false);
    expect(holdsBacklog([])).toBe(false);
    expect(resumeTarget([])).toBeNull();
  });
});
