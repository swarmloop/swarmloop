import type { EnvironmentInput, FailedCommand } from '../../environment/environment-types';
import type { EnvironmentService } from '../../environment/environment.service';
import type { Issue } from '../contract/step-contract';

/** The part of a pipeline job's trace that goes into a failed command: its end. */
const TRACE_TAIL_CHARS = 6000;

/**
 * The failed commands of the returned issues. A checks issue carries them as data. A pipeline issue carries its job
 * trace: each command the project also runs as a check that the trace names failed there, with the trace's end.
 */
async function failedCommands(
  environments: EnvironmentService,
  returns: Issue[] | null,
  place: EnvironmentInput,
): Promise<FailedCommand[]> {
  const issues = returns ?? [];
  const traces = issues.filter((issue) => issue.source === 'pipeline' && !issue.failed);
  const listed = traces.length > 0 ? await environments.checkCommands(place) : [];
  return [
    ...issues.flatMap((issue) => issue.failed ?? []),
    ...traces.flatMap(({ body }) =>
      listed
        .filter(({ command }) => body.includes(command))
        .map((check) => ({ ...check, tail: body.slice(-TRACE_TAIL_CHARS) })),
    ),
  ];
}

/** Runs again the commands that the returned issues name as failed. Returns the ones still red. */
export async function rerunFailed(
  environments: EnvironmentService,
  returns: Issue[] | null,
  place: EnvironmentInput,
): Promise<FailedCommand[]> {
  return environments.rerun(place, await failedCommands(environments, returns, place));
}
