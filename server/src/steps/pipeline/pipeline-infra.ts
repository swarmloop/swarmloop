import type { SwarmloopEnv } from '../../config/env';
import type { RunStop } from '../../agent/run-stop';
import { assertNotStopped } from '../../agent/step-stopped';
import { delay } from '../../core/delay';
import type { CodeHost } from '../../integrations/code-host/code-host';
import type { StepContext } from '../base-step';
import type { StepResult } from '../contract/step-contract';
import { finishedRuns, rerunJobs } from './ci-host';
import { infraBlockedEnd } from './pipeline-infra-end';
import type { CiScope } from './pipeline-no-ci';
import { unstartedRuns, type InfraCode, type Seen, type Verdict } from './pipeline-report';

/** The pauses before the two automatic re-runs of a run whose jobs never ran. */
const RERUN_PAUSES_MS = [60_000, 300_000];

/** What the infra route needs from the pipeline step: the stop signal, a new wait and the routing of what it saw. */
interface InfraDeps {
  runStop: RunStop;
  watch: (ctx: StepContext, records: CiScope['records'], env: SwarmloopEnv, host: CodeHost) => Promise<WatchedCi>;
  route: (
    ctx: StepContext,
    env: SwarmloopEnv,
    scope: CiScope,
    seen: Seen[],
    verdict: Verdict,
    host: CodeHost,
    reruns: number,
  ) => Promise<StepResult>;
}

interface WatchedCi {
  seen: Seen[];
  verdict: Verdict;
}

/** What one infra route works on: the run, the CI it looked at, why it is infra and how many reruns it had. */
interface InfraCase {
  ctx: StepContext;
  env: SwarmloopEnv;
  scope: CiScope;
  seen: Seen[];
  code: InfraCode;
  host: CodeHost;
  reruns: number;
}

/**
 * A finished run with no failed job: the cause is on the CI side, so nothing goes to an agent.
 * Its jobs are re-run after each pause of RERUN_PAUSES_MS, then the run is routed again; when the last one ends the same way the run blocks.
 */
export async function infraRoute(deps: InfraDeps, infra: InfraCase): Promise<StepResult> {
  const { ctx, env, scope, seen, code, host, reruns } = infra;
  const { opened, calls } = ctx;
  const finished = finishedRuns(seen);
  const unstarted = unstartedRuns(seen);
  const pause = unstarted.length > 0 ? undefined : RERUN_PAUSES_MS[reruns];
  const errors: string[] = [];
  if (pause !== undefined) {
    await delay(pause);
    assertNotStopped(deps.runStop, opened.run.key);
    errors.push(...(await rerunJobs(host, finished, calls)));
    if (errors.length === 0) {
      const watched = await deps.watch(ctx, scope.records, env, host);
      return deps.route(ctx, env, scope, watched.seen, watched.verdict, host, reruns + 1);
    }
  }
  return infraBlockedEnd({
    opened,
    calls,
    host,
    code,
    seen,
    unstarted,
    finished,
    reruns,
    errors,
    startTimeoutMs: env.PIPELINE_START_TIMEOUT_MS,
  });
}
