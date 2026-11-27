import type { RunRepository } from '../../history/run.repository';
import type { RunRebase } from '../run-rebase';
import type { StepContext } from '../base-step';
import type { StepResult } from '../contract/step-contract';
import { ARTIFACTS } from '../contract/artifacts';
import { writeRunState } from '../../history/run-state';
import { isHostOutage } from '../../core/swarmloop-error';
import { ERROR_CODES } from '../../contract/error-codes';
import { ConflictException } from '@nestjs/common';
import { CI_LOOK_MS } from './ci-look';

/** What runs once the visit that asked for an automatic rebase is closed: the rebase itself, and the waits and blocks it can end in. */
export function automaticRebase(input: {
  ctx: StepContext;
  runs: RunRepository;
  rebase: Pick<RunRebase, 'rebase'>;
  halted: () => boolean;
  /** The code host's text of the conflict, handed to implement when the move leaves the head where it was. */
  hostConflict?: string;
  /** The tries to keep once the move ran: the earlier ones and the keys of this one. */
  record?: { history: string[]; keys: string[] };
}): NonNullable<StepResult['afterClose']> {
  const { ctx, runs, rebase } = input;
  const run = ctx.opened.run;
  const remember = async (): Promise<void> => {
    if (input.record) {
      await ctx.write(ARTIFACTS.pipelineRebases, JSON.stringify([...input.record.history, ...input.record.keys]));
    }
  };
  return async (ended) => {
    if (input.halted()) return { ...ended, message: 'automatic rebase cancelled by Stop' };
    try {
      const next = await rebase.rebase(run.key, false, false, false, false, input.hostConflict ?? null);
      await remember();
      return { ...ended, resume: next === 'resume' };
    } catch (error) {
      if (isHostOutage(error)) {
        await runs.change(run.key, (fresh) => {
          writeRunState(fresh, {
            status: 'waiting',
            reason: { code: ERROR_CODES.HOST_UNAVAILABLE, message: error.message, retryAt: error.retryAt },
          });
          fresh.stepStartedAt = null;
        });
        return { ...ended, message: error.message };
      }
      if (error instanceof ConflictException && error.message === ERROR_CODES.SUBTASKS_RUNNING) {
        const retryAt = new Date(ctx.clock.now() + CI_LOOK_MS).toISOString();
        const message = `the epic's parts are still running; next try at ${retryAt}`;
        await runs.change(run.key, (fresh) => {
          writeRunState(fresh, { status: 'waiting', reason: { code: ERROR_CODES.CI_NOT_STARTED, message, retryAt } });
          fresh.stepStartedAt = null;
        });
        return { ...ended, message };
      }
      await remember();
      const detail = `automatic rebase failed: ${error instanceof Error ? error.message : 'unknown error'}`;
      await ctx.write(ARTIFACTS.error, `${detail}\n`);
      await runs.change(run.key, (fresh) => {
        writeRunState(fresh, { status: 'blocked', reason: { code: ERROR_CODES.REBASE_CONFLICT, message: detail } });
        fresh.stepStartedAt = null;
      });
      return { exitCode: 1, message: detail };
    }
  };
}
