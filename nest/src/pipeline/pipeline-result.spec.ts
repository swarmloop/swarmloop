import { autoContinues, continues, continuesSameStep, countedVisits, diedLog, loopMark, nextStep, normalizePhases, PHASES, settle, visitStatus } from './pipeline-result';

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

describe('diedLog', () => {
  it('keeps the saved output and notes that the process died', () => {
    expect(diedLog('')).toBe('process died\n');
    expect(diedLog('thinking\n')).toBe('thinking\nprocess died\n');
  });
});

describe('phases', () => {
  it('keeps every phase when none are named and always keeps requirements', () => {
    expect(normalizePhases()).toEqual([...PHASES]);
    expect(() => normalizePhases(['qa'])).toThrow('qa is not a phase');
    expect(normalizePhases(['ci', 'merge-request'])).toEqual(['requirements', 'ci']);
    expect(() => normalizePhases(['nope'])).toThrow('nope is not a phase');
  });

  it('skips steps whose phase is off and lands on done after the last selected phase', () => {
    const selected = ['requirements', 'code-review'] as const;
    expect(nextStep('requirements')).toBe('prepare');
    expect(nextStep('requirements', selected)).toBe('code-review');
    expect(nextStep('prepare', selected)).toBe('code-review');
    expect(nextStep('plan-review')).toBe('branch');
    expect(nextStep('branch')).toBe('implement');
    expect(nextStep('plan-review', normalizePhases(['requirements', 'brainstorm']))).toBe('done');
    expect(nextStep('code-review', selected)).toBe('done');
    expect(settle('requirements', 'running', 'requirements', 'ok', undefined, selected)).toEqual({
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
    expect(nextStep('pipeline', ['requirements', 'ci'])).toBe('done');
    expect(continues('merge-request', null)).toBeNull();
  });

  it('lets the third looping visit run and does not auto-start a fourth', () => {
    const run = { status: 'waiting' as const, currentStep: 'code-review' };
    expect(autoContinues('implement-review', run, 2, 3)).toBe('code-review');
    expect(autoContinues('implement-review', run, 3, 3)).toBeNull();
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
});
