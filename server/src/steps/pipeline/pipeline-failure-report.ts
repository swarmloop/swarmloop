import { issueOf } from '../shared/handoff';
import type { Issue } from '../contract/step-contract';
import { readableJobTrace } from './job-trace';
import type { Failure, Seen } from './pipeline-report';

/** One issue per failed job, or one for the whole log when the jobs are not separable. */
export function failureIssues(failures: Failure[], log: string): Issue[] {
  if (failures.length === 0) {
    return [issueOf('pipeline', 'pipeline failed', log)];
  }
  return failures.map((failure) =>
    issueOf('pipeline', `${failure.project} ${failure.name} (${failure.stage}) failed`, failure.trace),
  );
}

export function renderFail(failures: Failure[], seen: Seen[], intro = ''): string {
  const head = intro.trim() ? `${intro.trim()}\n` : '';
  if (failures.length === 0) {
    const failed = seen
      .filter((item) => item.status === 'failed' || item.status === 'canceled')
      .map((item) =>
        [
          `project: ${item.project}`,
          `pipeline: ${item.id ?? ''}`,
          `status: ${item.status}`,
          item.url ? `url: ${item.url}` : '',
        ]
          .filter((line) => line !== '')
          .join('\n'),
      );
    return `${head}result: fail\n${failed.join('\n\n')}\n`;
  }
  const blocks = failures.map((failure) => {
    const lines = [
      `project: ${failure.project}`,
      `pipeline: ${failure.pipelineId}`,
      `job: ${failure.name}`,
      `stage: ${failure.stage}`,
    ];
    if (failure.url) {
      lines.push(`url: ${failure.url}`);
    }
    return `${lines.join('\n')}\n\n${failure.check ? failure.trace : readableJobTrace(failure.trace, failure.log)}`;
  });
  return `${head}result: fail\n${blocks.join('\n\n')}\n`;
}

/** The block text for failed jobs whose log could not be read, or null when every log was read. */
export function renderUnreadable(failures: Failure[]): string | null {
  const lost = failures.filter((failure) => failure.unavailable !== undefined);
  if (lost.length === 0) {
    return null;
  }
  const lines = ['CI_LOG_UNAVAILABLE: a failed job has no readable log, so there is nothing to return to the agent.'];
  for (const failure of lost) {
    lines.push(`- ${failure.project} ${failure.name}: ${failure.url}: ${failure.unavailable}`);
  }
  lines.push('Resume reads the log again.');
  return `${lines.join('\n')}\n`;
}
