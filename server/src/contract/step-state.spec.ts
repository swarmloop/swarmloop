import { ERROR_CODES } from './error-codes';
import { stepState } from './step-state';

const STATUSES = [
  'idle',
  'preparing',
  'running',
  'waiting',
  'returned',
  'failed',
  'blocked',
  'skipped',
  'done',
  'again',
  'odd',
];

describe('stepState', () => {
  it('has no step status that reads as the word waiting', () => {
    for (const status of STATUSES) {
      expect(stepState(status, null).word.toLowerCase()).not.toBe('waiting');
    }
  });

  it('gives returned and failed the error tone with their own icons', () => {
    const returned = stepState('returned', null);
    const failed = stepState('failed', null);

    expect(returned.tone).toBe('error');
    expect(failed.tone).toBe('error');
    expect(returned.icon).toBe('returned');
    expect(failed.icon).toBe('failed');
    expect(stepState('blocked', null)).toEqual(failed);
  });

  it('maps a waiting step to paused for a runtime limit and to idle otherwise', () => {
    const limit = { code: ERROR_CODES.RUNTIME_LIMIT, message: 'limit' };

    expect(stepState('waiting', limit).icon).toBe('paused');
    expect(stepState('waiting', { code: 'NEEDS_ANSWERS', message: 'q' }).icon).toBe('idle');
    expect(stepState('waiting', null).icon).toBe('idle');
  });

  it('maps the working states and the rest', () => {
    expect(stepState('running', null)).toMatchObject({ tone: 'working', icon: 'working' });
    expect(stepState('preparing', null)).toMatchObject({ tone: 'working', icon: 'preparing' });
    expect(stepState('done', null)).toMatchObject({ tone: 'done', icon: 'done' });
    expect(stepState('skipped', null)).toMatchObject({ tone: 'neutral', icon: 'skipped' });
    expect(stepState('again', null)).toEqual({ word: 'Will run again', tone: 'neutral', icon: 'idle' });
    expect(stepState('odd', null).icon).toBe('idle');
  });
});
