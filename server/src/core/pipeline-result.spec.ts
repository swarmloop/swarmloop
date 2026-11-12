import {
  autoContinues,
  continues,
  continuesSameStep,
  countedVisits,
  failedAttemptLaunches,
  failedLaunches,
  loopMark,
  nextStep,
  normalizePhases,
  settle,
  visitStatus,
} from './pipeline-result';
import { PHASES } from '../contract/steps';

describe('visitStatus', () => {
  it('marks a finished success done and keeps a real pause waiting', () => {
    expect(visitStatus('ok')).toBe('done');
    expect(visitStatus('waiting')).toBe('waiting');
    expect(visitStatus('failed')).toBe('failed');
    expect(visitStatus('blocked')).toBe('blocked');
  });
});

describe('continuesSameStep', () => {
  it('lets a failed or paused visit finish and refuses a step that has not started', () => {
    expect(continuesSameStep('failed', 'implement', 'implement', 'failed')).toBe(true);
    expect(continuesSameStep('waiting', 'research', 'research', 'waiting')).toBe(true);
    expect(continuesSameStep('waiting', 'plan', 'plan', null)).toBe(false);
    expect(continuesSameStep('waiting', 'plan', 'plan', 'done')).toBe(false);
    expect(continuesSameStep('waiting', 'implement', 'plan', 'waiting')).toBe(false);
  });
});

describe('phases', () => {
  it('keeps every phase when none are named and always keeps planning', () => {
    expect(normalizePhases()).toEqual([...PHASES]);
    expect(() => normalizePhases(['qa'])).toThrow('qa is not a phase');
    expect(normalizePhases(['ci', 'merge-request'])).toEqual(['planning', 'ci']);
    expect(() => normalizePhases(['nope'])).toThrow('nope is not a phase');
  });

  it('skips steps whose phase is off and lands on done after the last selected phase', () => {
    const selected = ['planning', 'code-review'] as const;
    expect(nextStep('requirements')).toBe('prepare');
    expect(nextStep('plan-improve', selected)).toBe('code-review');
    expect(nextStep('prepare', selected)).toBe('research');
    expect(nextStep('plan-improve')).toBe('branch');
    expect(nextStep('implement-improve')).toBe('checks');
    expect(nextStep('implement-improve', ['planning', 'implementation', 'code-review'])).toBe('code-review');
    expect(nextStep('implement-improve', ['planning', 'implementation'])).toBe('done');
    expect(nextStep('implement-improve', ['planning', 'implementation', 'checks'])).toBe('checks');
    expect(nextStep('branch')).toBe('implement');
    expect(nextStep('plan-improve', normalizePhases(['planning']))).toBe('done');
    expect(nextStep('code-review', selected)).toBe('done');
    expect(settle('plan-improve', 'running', 'plan-improve', 'ok', undefined, selected)).toEqual({
      currentStep: 'code-review',
      status: 'waiting',
    });
    expect(settle('code-review', 'running', 'code-review', 'ok', undefined, selected)).toEqual({
      currentStep: 'done',
      status: 'done',
    });
  });
});

describe('continues', () => {
  it('follows a step that advanced and stops on a pause', () => {
    expect(continues('prepare', { status: 'waiting', currentStep: 'research' })).toBe('research');
    expect(continues('research', { status: 'waiting', currentStep: 'research' })).toBeNull();
    expect(continues('pipeline', { status: 'failed', currentStep: 'implement' })).toBeNull();
    expect(continues('merge-request', { status: 'waiting', currentStep: 'pipeline' })).toBe('pipeline');
    expect(continues('pipeline', { status: 'done', currentStep: 'done' })).toBeNull();
    expect(nextStep('code-review')).toBe('commit');
    expect(nextStep('commit')).toBe('merge-request');
    expect(nextStep('merge-request')).toBe('pipeline');
    expect(nextStep('pipeline')).toBe('done');
    expect(nextStep('pipeline', ['planning', 'ci'])).toBe('done');
    expect(continues('merge-request', null)).toBeNull();
  });

  it('lets the third looping visit run and does not auto-start a fourth', () => {
    const run = { status: 'waiting' as const, currentStep: 'code-review' };
    expect(autoContinues('implement-improve', run, 2, 3)).toBe('code-review');
    expect(autoContinues('implement-improve', run, 3, 3)).toBeNull();
    expect(autoContinues('commit', { status: 'waiting', currentStep: 'pipeline' }, 3, 3)).toBeNull();
    expect(autoContinues('code-review', { status: 'waiting', currentStep: 'commit' }, 3, 3)).toBe('commit');
  });

  it('counts loop visits after a manual mark and ignores the earlier ones', () => {
    const stats = [
      { id: 10, step: 'code-review' },
      { id: 11, step: 'code-review' },
      { id: 12, step: 'code-review' },
      { id: 13, step: 'code-review' },
    ];
    expect(loopMark('12\n')).toBe(12);
    expect(loopMark(null)).toBe(0);
    expect(countedVisits(stats, 'code-review', 12)).toBe(1);
    expect(countedVisits(stats, 'code-review', 0)).toBe(4);
  });

  it('counts a failed visit that was recorded as the mark', () => {
    const stats = [
      { id: 4, step: 'code-review', status: 'done' },
      { id: 9, step: 'implement', status: 'failed' },
      { id: 10, step: 'code-review', status: 'failed' },
    ];
    expect(failedLaunches(stats, 'code-review', 10)).toBe(1);
    expect(failedLaunches(stats, 'code-review', 4)).toBe(1);
    expect(failedLaunches(stats, 'implement', 9)).toBe(1);
    expect(failedLaunches(stats, 'code-review', 11)).toBe(0);
  });

  describe('failedAttemptLaunches', () => {
    const visit = (id: number, attemptId: string | null, step = 'implement', status = 'failed') => ({
      id,
      step,
      status,
      attemptId,
    });

    it('counts a dead attempt whose visit is stored once', () => {
      expect(failedAttemptLaunches([visit(1, 'a1')], 'implement', 0, 'a1')).toBe(1);
    });

    it('counts a dead attempt whose visit is not stored yet', () => {
      expect(failedAttemptLaunches([], 'implement', 0, 'a1')).toBe(1);
    });

    it('counts two attempts', () => {
      expect(failedAttemptLaunches([visit(1, 'a1'), visit(2, 'a2')], 'implement', 0, 'a2')).toBe(2);
      expect(failedAttemptLaunches([visit(1, 'a1')], 'implement', 0, 'a2')).toBe(2);
    });

    it('ignores a visit below the mark, another step and a visit that did not fail', () => {
      const stats = [
        visit(1, 'a1'),
        visit(5, 'a2', 'code-review'),
        visit(6, 'a3', 'implement', 'done'),
        visit(7, null),
      ];
      expect(failedAttemptLaunches(stats, 'implement', 3, 'a4')).toBe(1);
    });
  });
});
