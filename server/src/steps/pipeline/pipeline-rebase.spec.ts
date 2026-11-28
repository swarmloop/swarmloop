import { ConflictException } from '@nestjs/common';
import { ERROR_CODES } from '../../contract/error-codes';
import { storedState } from '../../history/run-state';
import type { RunEntity } from '../../history/entities';
import type { RunRepository } from '../../history/run.repository';
import { FakeClock } from '../../core/fake-clock.spec-helpers';
import type { StepContext } from '../base-step';
import type { RunRebase } from '../run-rebase';
import { automaticRebase } from './pipeline-rebase';

/** Runs the work after the visit closed, with a Rebase that throws `failure`; returns the run and what the work ended in. */
async function afterClose(failure: Error) {
  const run = { key: 'PROJ-1', status: 'running', currentStep: 'pipeline', stepStartedAt: 'x' } as unknown as RunEntity;
  const runs = {
    change: async (_key: string, change: (fresh: RunEntity) => void) => change(run),
  } as unknown as RunRepository;
  const written: string[] = [];
  const ctx = {
    opened: { run },
    clock: new FakeClock(),
    write: async (_artifact: unknown, text: string) => void written.push(text),
  } as unknown as StepContext;
  const rebase = { rebase: () => Promise.reject(failure) } as unknown as Pick<RunRebase, 'rebase'>;
  const ended = await automaticRebase({ ctx, runs, rebase, halted: () => false })({ exitCode: 0, message: '' });
  return { run, ended, written };
}

describe('automatic rebase', () => {
  it("waits with its next try when an epic's parts still run", async () => {
    const { run, ended } = await afterClose(new ConflictException(ERROR_CODES.SUBTASKS_RUNNING));

    const { state, reason } = storedState(run);
    expect(state).toBe('waiting');
    expect(reason).toMatchObject({ code: ERROR_CODES.CI_NOT_STARTED, retryAt: '2026-01-01T00:02:00.000Z' });
    expect(reason?.message).toContain("automatic rebase waits for the epic's tasks to settle");
    expect(ended.exitCode).not.toBe(1);
  });

  it('blocks as a rebase conflict for any other failure', async () => {
    const { run, ended } = await afterClose(new ConflictException('merge failed'));

    const { state, reason } = storedState(run);
    expect(state).toBe('blocked');
    expect(reason?.code).toBe(ERROR_CODES.REBASE_CONFLICT);
    expect(ended.exitCode).toBe(1);
  });
});
