import type { CodeHost } from '../../integrations/code-host/code-host';
import { FetchFailed, type HttpCallDraft } from '../../core/swarmloop-error';
import type { Failure, Seen } from './pipeline-report';

/** The runs of a red pipeline that the host can still act on. */
export function finishedRuns(seen: Seen[]): Seen[] {
  return seen.filter((item) => (item.status === 'failed' || item.status === 'canceled') && item.id !== null);
}

function noteCalls(error: unknown, calls: HttpCallDraft[]): void {
  if (error instanceof FetchFailed) {
    calls.push(...error.httpCalls);
  }
}

/** Asks the host to re-run the failed and never-started jobs of each run. Returns one error text per run it refused. */
export async function rerunJobs(host: CodeHost, runs: Seen[], calls: HttpCallDraft[]): Promise<string[]> {
  const errors: string[] = [];
  for (const item of runs) {
    try {
      calls.push(...(await host.rerunFailedJobs(item.project, item.id as number)).httpCalls);
    } catch (error) {
      noteCalls(error, calls);
      errors.push(`${item.project}: ${error instanceof Error ? error.message : 're-run failed'}`);
    }
  }
  return errors;
}

/** What the host says about runs that did not run, as one text. A read that fails adds nothing. */
export async function readNotes(host: CodeHost, runs: Seen[], calls: HttpCallDraft[]): Promise<string> {
  const notes: string[] = [];
  for (const item of runs) {
    try {
      const read = await host.readRunNotes(item.project, item.id as number);
      calls.push(...read.httpCalls);
      notes.push(read.notes);
    } catch (error) {
      noteCalls(error, calls);
    }
  }
  return notes.filter(Boolean).join(' ');
}

/** The jobs whose status is in `counted`, with their logs, or why a log could not be read. */
export async function readFailures(
  seen: Seen[],
  calls: HttpCallDraft[],
  host: CodeHost,
  counted: string[],
): Promise<Failure[]> {
  const wanted = finishedRuns(seen).flatMap((item) =>
    item.jobs
      .filter((job) => counted.includes(job.status) && !job.allowFailure)
      .map((job) => ({ project: item.project, pipelineId: item.id as number, url: item.url, job })),
  );
  const loaded = await Promise.all(
    wanted.map(async (item) => {
      try {
        const trace = await host.readJobTrace(item.project, item.job.id);
        return { item, trace: trace.trace, calls: trace.httpCalls };
      } catch (error) {
        const message = error instanceof Error ? error.message : 'pipeline failed';
        return { item, trace: '', unavailable: message, calls: error instanceof FetchFailed ? error.httpCalls : [] };
      }
    }),
  );
  const failures: Failure[] = [];
  for (const row of loaded) {
    calls.push(...row.calls);
    failures.push({
      project: row.item.project,
      pipelineId: row.item.pipelineId,
      name: row.item.job.name,
      stage: row.item.job.stage,
      url: row.item.url,
      trace: row.trace,
      ...(row.unavailable === undefined ? {} : { unavailable: row.unavailable }),
    });
  }
  return failures;
}
