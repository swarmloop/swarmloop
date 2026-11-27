import type { SwarmloopEnv } from '../../config/env';
import type { CodeHost, PipelineRef } from '../../integrations/code-host/code-host';
import type { AwakeTime } from '../../core/awake-time';
import type { RunStop } from '../../agent/run-stop';
import { delay } from '../../core/delay';
import { assertNotStopped } from '../../agent/step-stopped';
import type { StepContext } from '../base-step';
import { missingRuns } from './missing-pipeline';
import { externalWork, verdictOf, waitingFor, type Seen, type Verdict } from './pipeline-report';
import { loadSeen } from './load-seen';
import { stuckAtStart } from './stuck-start';

/** What the wait for CI needs from its step: the awake clock of this wait, the run's stop and where the worktrees are. */
interface WatchDeps {
  awake: AwakeTime;
  runStop: RunStop;
  root: string;
}

/** The first look at the CI of every ref, then the wait for a run that has not started or has not ended. */
export async function watchCi(
  ctx: StepContext,
  records: PipelineRef[],
  env: SwarmloopEnv,
  host: CodeHost,
  { awake, runStop, root }: WatchDeps,
): Promise<{ seen: Seen[]; verdict: Verdict }> {
  const { calls } = ctx;
  assertNotStopped(runStop, ctx.opened.run.key);
  let seen = await awake.run(() => loadSeen(records, calls, host, false));
  let verdict = verdictOf(seen);
  let said: string | null = null;
  const unstartedSince = new Map<number, number>();
  stuckAtStart(unstartedSince, seen, awake.elapsedMs(), env.PIPELINE_START_TIMEOUT_MS);
  while (
    awake.elapsedMs() < env.PIPELINE_TIMEOUT_MS &&
    (verdict === 'wait' || verdict === 'absent' || verdict === 'green')
  ) {
    const missing = verdict === 'wait' ? null : await awake.run(() => missingRuns(ctx, root, seen));
    if (verdict === 'green' && !(missing && missing.length > 0)) {
      break;
    }
    if (verdict === 'absent' && missing?.length === 0) {
      break;
    }
    const limit = verdict === 'wait' ? env.PIPELINE_TIMEOUT_MS : env.PIPELINE_START_TIMEOUT_MS;
    const pause = Math.min(env.TICK_MS, limit - awake.elapsedMs());
    if (pause <= 0) {
      break;
    }
    await delay(pause);
    assertNotStopped(runStop, ctx.opened.run.key, externalWork(seen));
    seen = await awake.run(() => loadSeen(records, calls, host));
    verdict = verdictOf(seen);
    const waiting = verdict === 'wait' ? waitingFor(seen) : null;
    if (waiting && waiting !== said) {
      await ctx.activity(waiting, () => Promise.resolve());
    }
    said = waiting ?? said;
    if (stuckAtStart(unstartedSince, seen, awake.elapsedMs(), env.PIPELINE_START_TIMEOUT_MS)) {
      return { seen, verdict: 'unstarted' };
    }
  }
  return { seen, verdict };
}
