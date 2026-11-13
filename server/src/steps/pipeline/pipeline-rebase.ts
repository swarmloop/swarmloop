import type { RunRepository } from '../../history/run.repository';
import type { RunRebase } from '../run-rebase';
import type { StepContext } from '../base-step';
import type { StepResult } from '../contract/step-contract';
import { ARTIFACTS } from '../contract/artifacts';
import { writeRunState } from '../../history/run-state';
import { HostUnavailable } from '../../core/swarmloop-error';
import { ERROR_CODES } from '../../contract/error-codes';

/** What runs once the visit that asked for an automatic rebase is closed: the rebase itself, and the waits and blocks it can end in. */
export function automaticRebase(input: {
  ctx: StepContext;
  runs: RunRepository;
  rebase: Pick<RunRebase, 'rebase'>;
  halted: () => boolean;
}): NonNullable<StepResult['afterClose']> {
  const { ctx, runs, rebase } = input;
  const run = ctx.opened.run;
  return async (ended) => {
    if (input.halted()) return { ...ended, message: 'automatic rebase cancelled by Stop' };
    try {
      const next = await rebase.rebase(run.key);
      return { ...ended, resume: next === 'resume' };
    } catch (error) {
      if (error instanceof HostUnavailable) {
        const fresh = (await runs.findRun(run.key))!;
        writeRunState(fresh, {
          status: 'waiting',
          reason: { code: ERROR_CODES.HOST_UNAVAILABLE, message: error.message, retryAt: error.retryAt },
        });
        fresh.stepStartedAt = null;
        await runs.saveRun(fresh);
        return { ...ended, message: error.message };
      }
      const detail = `automatic rebase failed: ${error instanceof Error ? error.message : 'unknown error'}`;
      const fresh = (await runs.findRun(run.key))!;
      writeRunState(fresh, { status: 'blocked', reason: { code: ERROR_CODES.REBASE_CONFLICT, message: detail } });
      fresh.stepStartedAt = null;
      await ctx.write(ARTIFACTS.error, `${detail}\n`);
      await runs.saveRun(fresh);
      return { exitCode: 1, message: detail };
    }
  };
}
