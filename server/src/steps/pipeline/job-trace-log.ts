import { writeFileSync } from 'fs';
import { runLogContainerPath, runLogPath } from '../../core/run-logs';
import { wholeJobTrace } from './job-trace';
import type { Failure } from './pipeline-report';

/** Saves the whole cleaned trace of a failed job in the run's log folder; returns the path the agent reads it at. */
export function saveJobTrace(root: string, key: string, attempt: string, index: number, failure: Failure): string {
  const file = runLogPath(root, key, `pipeline-${attempt}-job-${index}`);
  writeFileSync(file, wholeJobTrace(failure.trace).join('\n'));
  return runLogContainerPath(file);
}
