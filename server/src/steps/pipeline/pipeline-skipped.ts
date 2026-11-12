import { basename } from 'path';
import type { EnvironmentService } from '../../environment/environment.service';
import type { Failure } from './pipeline-report';

/**
 * Ends the trace of a failed job with `<name> was skipped by its paths` for each command that its `paths` skipped in the
 * last checks visit and that the job is named like, so the project can fix its paths. The visit precedes the commit CI
 * runs on, so no commit can be compared.
 */
export async function noteSkippedByPaths(
  environments: Pick<EnvironmentService, 'skippedChecks'>,
  key: string,
  failures: Failure[],
): Promise<void> {
  for (const failure of failures) {
    const skipped = await environments.skippedChecks(key, basename(failure.project));
    const job = failure.name.toLowerCase();
    for (const name of skipped?.names ?? []) {
      const own = name.toLowerCase();
      const line = `${name} was skipped by its paths`;
      if ((job.includes(own) || own.includes(job)) && !failure.trace.includes(line)) {
        failure.trace = `${failure.trace.trimEnd()}\n${line}\n`;
      }
    }
  }
}
