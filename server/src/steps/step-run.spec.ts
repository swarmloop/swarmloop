import type { RunEntity } from '../history/entities';
import { repositoryVisit } from '../history/repository.spec-helpers';
import { closeStep } from './step-run';

describe('closeStep', () => {
  it('writes the visit and the run with one finalize call', async () => {
    const run = { id: 1, key: 'K-1', status: 'running', currentStep: 'research' } as RunEntity;
    const visit = repositoryVisit();
    const finalize = jest.fn().mockResolvedValue(null);
    const finishVisit = jest.fn();
    const saveRun = jest.fn();
    const notify = jest.fn();
    const result = await closeStep({
      runs: { saveRun, notify } as never,
      visits: { finalize, finishVisit } as never,
      flows: { activePhases: jest.fn().mockResolvedValue(['planning']) } as never,
      root: '/tmp',
      clock: {} as never,
      run,
      attemptId: 'attempt-1',
      previousStep: 'research',
      previousStatus: 'running',
      step: 'research',
      outcome: 'ok',
      visit,
      line: 'research done',
      exitCode: 0,
    });
    expect(finalize).toHaveBeenCalledTimes(1);
    expect(finalize).toHaveBeenCalledWith('attempt-1', run, visit);
    expect(finishVisit).not.toHaveBeenCalled();
    expect(saveRun).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith('K-1');
    expect(result).toEqual({ exitCode: 0, message: 'research done' });
  });
});
