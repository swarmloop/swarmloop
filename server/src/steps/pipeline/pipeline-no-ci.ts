import type { HttpCallDraft } from '../../core/swarmloop-error';
import type { CodeHost, PipelineRef } from '../../integrations/code-host/code-host';
import { noCi } from '../shared/ci-reading';
import type { Seen } from './pipeline-report';

/** What a run that no project has CI for says first; the pipeline log of such a run starts with it. */
export const NO_CI_PREFIX = 'CI skipped: no CI on';

/** A project of the run that has no CI, and why the rule reads it so. `refused`: the host will never show its runs. */
export interface NoCiProject {
  project: string;
  cause: string;
  refused: boolean;
}

/** What the step waits for: the records and what was seen of them, and the projects left out of the wait. */
export interface CiScope {
  records: PipelineRef[];
  seen: Seen[];
  dropped: NoCiProject[];
}

/**
 * Leaves out each project that showed no run and no check and has no CI by the one rule (`noCi`). A project whose host
 * refuses to read its pipelines can never show a run, so it is left out whatever its tree holds. A project that never
 * had one is left out unless its tree has a CI file (`ciFiles`): that one is waited for, and a run that never starts is
 * a missing pipeline. The rest is waited for as it is.
 */
export async function dropNoCi(
  host: CodeHost,
  records: PipelineRef[],
  seen: Seen[],
  calls: HttpCallDraft[],
  ciFiles: Set<string>,
): Promise<CiScope> {
  const dropped: NoCiProject[] = [];
  for (const item of seen) {
    const record = records.find((ref) => ref.project === item.project);
    if (!record || item.runs.length > 0 || item.checks.length > 0) {
      continue;
    }
    const { cause, refused, httpCalls } = await noCi(host, record);
    calls.push(...httpCalls);
    if (cause && (refused || !ciFiles.has(item.project))) {
      dropped.push({ project: item.project, cause, refused });
    }
  }
  const gone = new Set(dropped.map((item) => item.project));
  return {
    records: records.filter((ref) => !gone.has(ref.project)),
    seen: seen.filter((item) => !gone.has(item.project)),
    dropped,
  };
}

/** Why a run with no CI at all ends skipped, in the words of a CI skip. */
export function noCiReason(dropped: NoCiProject[]): string {
  return `${NO_CI_PREFIX} ${dropped.map((item) => `${item.project} (${item.cause})`).join('; no CI on ')}`;
}

/** One line for each project left out of a run that still waited for the others. */
export function noCiLines(dropped: NoCiProject[]): string {
  return dropped.map((item) => `no CI: ${item.project} (${item.cause})\n`).join('');
}
