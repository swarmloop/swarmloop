import { delay } from '../../core/delay';
import type { AwakeTime } from '../../core/awake-time';
import type { SwarmloopEnv } from '../../config/env';
import type { CodeHost } from '../../integrations/code-host/code-host';
import { FetchFailed, HostUnavailable, type HttpCallDraft } from '../../core/swarmloop-error';
import { cancelErrorNote, isRunning, runRows, type Seen } from './pipeline-report';

type LoadSeen = (jobs?: boolean) => Promise<Seen[]>;

/** Cancels the runs still going after the wait, then waits for them to stop. */
export async function cancelRunning(input: {
  seen: Seen[];
  calls: HttpCallDraft[];
  env: SwarmloopEnv;
  host: CodeHost;
  load: LoadSeen;
  awakeTime: () => AwakeTime;
}): Promise<{ seen: Seen[]; note: string; traces: boolean }> {
  const { seen, calls, env, host, load } = input;
  const minutes = Math.round(env.PIPELINE_TIMEOUT_MS / 60000);
  const running = runRows(seen, isRunning);
  const errors: string[] = [];
  for (const item of running) {
    try {
      const result = await host.cancelPipeline(item.project, item.id);
      calls.push(...result.httpCalls);
    } catch (error) {
      if (error instanceof HostUnavailable) {
        throw error;
      }
      if (error instanceof FetchFailed) {
        calls.push(...error.httpCalls);
      }
      const message = error instanceof Error ? error.message : 'cancel failed';
      errors.push(`${item.project}: ${message}`);
    }
  }
  if (errors.length > 0) {
    let rows = running;
    try {
      const named = await load();
      rows = running.map((item) => {
        return runRows(named, isRunning).find((row) => row.project === item.project && row.id === item.id) ?? item;
      });
    } catch (error) {
      if (error instanceof HostUnavailable) {
        throw error;
      }
      if (error instanceof FetchFailed) {
        calls.push(...error.httpCalls);
      }
    }
    return { seen, note: cancelErrorNote(rows, errors), traces: false };
  }
  const awake = input.awakeTime();
  let current = seen;
  while (awake.elapsedMs() < env.PIPELINE_START_TIMEOUT_MS && runRows(current, isRunning).length > 0) {
    const pause = Math.min(env.TICK_MS, env.PIPELINE_START_TIMEOUT_MS - awake.elapsedMs());
    if (pause <= 0) {
      break;
    }
    await delay(pause);
    current = await awake.run(() => load(false));
  }
  return {
    seen: current,
    note: `It was still running after ${minutes} minutes and swarmloop canceled it`,
    traces: true,
  };
}
