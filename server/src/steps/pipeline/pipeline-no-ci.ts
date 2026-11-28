import type { CodeHost, PipelineRef } from '../../integrations/code-host/code-host';
import { projectHasCi } from '../shared/ci-reading';
import type { Seen } from './pipeline-report';

/** What a run that no project has CI for says first; the pipeline log of such a run starts with it. */
export const NO_CI_PREFIX = 'CI skipped: no CI on';

/** What the step waits for: the records and what was seen of them, and the projects left out of the wait. */
export interface CiScope {
  records: PipelineRef[];
  seen: Seen[];
  dropped: string[];
}

/**
 * Leaves out each project the code host reports no CI for (`projectHasCi`), before any pipeline is read. A host that
 * cannot answer rejects with its outage wait. The rest is waited for.
 */
export async function dropNoCi(
  host: CodeHost,
  records: PipelineRef[],
): Promise<{ records: PipelineRef[]; dropped: string[] }> {
  const dropped: string[] = [];
  for (const project of new Set(records.map((ref) => ref.project))) {
    if (!(await projectHasCi(host, project))) {
      dropped.push(project);
    }
  }
  return { records: records.filter((ref) => !dropped.includes(ref.project)), dropped };
}

/** Why a run with no CI at all ends skipped, in the words of a CI skip. */
export function noCiReason(dropped: string[]): string {
  return `${NO_CI_PREFIX} ${dropped.join('; no CI on ')}`;
}

/** One line for each project left out of a run that still waited for the others. */
export function noCiLines(dropped: string[]): string {
  return dropped.map((project) => `no CI: ${project}\n`).join('');
}
