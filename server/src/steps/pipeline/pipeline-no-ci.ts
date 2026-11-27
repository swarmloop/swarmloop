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

/** The records and what was seen of them, without the given projects. */
export function leaveOut(
  projects: NoCiProject[],
  records: PipelineRef[],
  seen: Seen[],
): { records: PipelineRef[]; seen: Seen[] } {
  const gone = new Set(projects.map((item) => item.project));
  return {
    records: records.filter((ref) => !gone.has(ref.project)),
    seen: seen.filter((item) => !gone.has(item.project)),
  };
}

/**
 * Leaves out each project that showed no run and no check and has no CI by the one rule (`noCi`): the host refuses to
 * read its pipelines, or neither its main nor the run's branch ever had one. The rest is waited for as it is.
 */
export async function dropNoCi(
  host: CodeHost,
  records: PipelineRef[],
  seen: Seen[],
  calls: HttpCallDraft[],
): Promise<{ records: PipelineRef[]; seen: Seen[]; dropped: NoCiProject[] }> {
  const dropped: NoCiProject[] = [];
  for (const item of seen) {
    const record = records.find((ref) => ref.project === item.project);
    if (!record || item.runs.length > 0 || item.checks.length > 0) {
      continue;
    }
    const { cause, refused, httpCalls } = await noCi(host, record);
    calls.push(...httpCalls);
    if (cause) {
      dropped.push({ project: item.project, cause, refused });
    }
  }
  return { ...leaveOut(dropped, records, seen), dropped };
}

/** Why a run with no CI at all ends skipped, in the words of a CI skip. */
export function noCiReason(dropped: NoCiProject[]): string {
  return `${NO_CI_PREFIX} ${dropped.map((item) => `${item.project} (${item.cause})`).join('; no CI on ')}`;
}

/** One line for each project left out of a run that still waited for the others. */
export function noCiLines(dropped: NoCiProject[]): string {
  return dropped.map((item) => `no CI: ${item.project} (${item.cause})\n`).join('');
}
