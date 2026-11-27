import type { RunRepository } from '../../history/run.repository';
import type { RunRebase } from '../run-rebase';
import type { StepContext } from '../base-step';
import type { StepResult } from '../contract/step-contract';
import { ARTIFACTS } from '../contract/artifacts';
import { writeRunState } from '../../history/run-state';
import { isHostOutage } from '../../core/swarmloop-error';
import { ERROR_CODES } from '../../contract/error-codes';

/** What runs once the visit that asked for an automatic rebase is closed: the rebase itself, and the waits and blocks it can end in. */
export function automaticRebase(input: {
  ctx: StepContext;
  runs: RunRepository;
  rebase: Pick<RunRebase, 'rebase'>;
  halted: () => boolean;
  /** What the code host said about the conflict; a head the move leaves in place goes to implement with it. */
  hostConflict?: string;
}): NonNullable<StepResult['afterClose']> {
  const { ctx, runs, rebase } = input;
  const run = ctx.opened.run;
  return async (ended) => {
    if (input.halted()) return { ...ended, message: 'automatic rebase cancelled by Stop' };
    try {
      const next = await rebase.rebase(run.key, false, false, false, false, input.hostConflict ?? null);
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
