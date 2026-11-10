import { issueOf } from '../shared/handoff';
import type { Issue } from '../contract/step-contract';
import type { PipelineJob, PipelineRef } from '../../integrations/code-host/code-host';
import { readableJobTrace } from './job-trace';
import { basename } from 'path';
import { git } from '../../git/git';
import { captureTree, git as quietGit } from '../../git/worktree-tree';
import type { SandboxMount } from '../../core/sandbox-mount';
import { remoteProject } from '../merge-request/merge-request-record';

export interface Seen {
  project: string;
  id: number | null;
  sha: string;
  url: string;
  status: string;
  jobs: PipelineJob[];
}

export interface Failure {
  project: string;
  pipelineId: number;
  name: string;
  stage: string;
  url: string;
  trace: string;
  /** Why the log of this job could not be read; then `trace` is empty. */
  unavailable?: string;
}

/** One issue per failed job, or one for the whole log when the jobs are not separable. */
export function failureIssues(failures: Failure[], log: string): Issue[] {
  if (failures.length === 0) {
    return [issueOf('pipeline', 'pipeline failed', log)];
  }
  return failures.map((failure) =>
    issueOf('pipeline', `${failure.project} ${failure.name} (${failure.stage}) failed`, failure.trace),
  );
}

export function renderNone(seen: Seen[]): string {
  const lines = ['result: none', 'nothing started'];
  for (const item of seen) {
    lines.push(`project: ${item.project}`);
  }
  return `${lines.join('\n')}\n`;
}

export function renderPass(seen: Seen[], warnings: string[]): string {
  const lines = ['result: pass'];
  for (const item of seen) {
    lines.push(`project: ${item.project}`);
    if (item.id) {
      lines.push(`pipeline: ${item.id}`);
    }
    if (item.sha) {
      lines.push(`sha: ${item.sha}`);
    }
  }
  lines.push(...warnings.map((warning) => `warning: ${warning}`));
  return `${lines.join('\n')}\n`;
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
    return `${lines.join('\n')}\n\n${readableJobTrace(failure.trace)}`;
  });
  return `${head}result: fail\n${blocks.join('\n\n')}\n`;
}

export function cancelErrorNote(running: Seen[], errors: string[]): string {
  const lines = ['result: fail'];
  for (const item of running) {
    lines.push(`project: ${item.project}`);
    if (item.id !== null) {
      lines.push(`pipeline: ${item.id}`);
    }
    if (item.url) {
      lines.push(`url: ${item.url}`);
    }
    const names = item.jobs.map((job) => job.name).filter((name) => name !== '');
    lines.push(...(names.length > 0 ? names.map((name) => `job: ${name}`) : ['job: running']));
  }
  lines.push(...errors.map((error) => `cancel: ${error}`));
  return lines.join('\n');
}

export function parsePipelineRefs(body: string): PipelineRef[] {
  const records: PipelineRef[] = [];
  let project = '';
  let ref = '';
  let sha = '';
  const flush = (): void => {
    if (project && ref) {
      records.push({ project, ref, sha });
    }
    project = '';
    ref = '';
    sha = '';
  };
  for (const line of body.split('\n')) {
    if (line.startsWith('project: ')) {
      if (project || ref) {
        flush();
      }
      project = line.slice('project: '.length).trim();
    } else if (line.startsWith('ref: ')) {
      ref = line.slice('ref: '.length).trim();
    } else if (line.startsWith('sha: ')) {
      sha = line.slice('sha: '.length).trim();
    }
  }
  flush();
  return records;
}

function safeProject(origin: string): string | null {
  try {
    return remoteProject(origin).project;
  } catch {
    return null;
  }
}

export async function originProject(dir: string): Promise<string | null> {
  try {
    return safeProject(await git(['-C', dir, 'remote', 'get-url', 'origin']));
  } catch {
    return null;
  }
}

/** One `<repo> <ci sha> -> <head>` line per repo whose HEAD is not the commit CI ran on. Empty when nothing is stale. */
export async function staleRepos(refBody: string | null, mounts: SandboxMount[]): Promise<string[]> {
  const records = parsePipelineRefs(refBody ?? '');
  const lines: string[] = [];
  for (const mount of mounts) {
    const project = await originProject(mount.hostPath);
    const sha = records.find((record) => record.project === project)?.sha;
    if (!project || !sha) {
      continue;
    }
    const head = await git(['-C', mount.hostPath, 'rev-parse', 'HEAD']);
    if (head !== sha) {
      lines.push(`${basename(mount.hostPath)} ${sha} -> ${head}`);
    }
  }
  return lines;
}

const NOT_RUN = ['queued', 'pending', 'waiting', 'created', 'waiting_for_resource', 'canceled', 'startup_failure'];

type CiCause = 'failed' | 'not-run' | 'timeout';
export type InfraCode = 'CI_NOT_RUN' | 'CI_TIMEOUT';

/** Why a finished run is red: a failed job (or no job to tell), jobs that never ran, or only timed-out jobs. */
export function classify(seen: Seen[]): CiCause {
  const statuses = seen.flatMap((item) => item.jobs.map((job) => job.status));
  if (statuses.length === 0 || statuses.includes('failed')) {
    return 'failed';
  }
  return statuses.some((status) => NOT_RUN.includes(status)) ? 'not-run' : 'timeout';
}

/** The pipeline log of a run that did not run its jobs: one line with the code, then one `job:` line per job. */
export function renderInfra(code: InfraCode, seen: Seen[], notes: string): string {
  const wanted = code === 'CI_TIMEOUT' ? ['timed_out'] : NOT_RUN;
  const names = seen.flatMap((item) => item.jobs.filter((job) => wanted.includes(job.status)).map((job) => job.name));
  const url = seen.find((item) => item.url)?.url ?? '';
  const what = code === 'CI_TIMEOUT' ? `${names.join(', ')} timed out` : `CI did not run ${names.join(', ')}`;
  const line = [`${code}: ${what}${notes ? `: ${notes}` : ''}`, url].filter(Boolean).join(' ');
  return `${[line, ...names.map((name) => `job: ${name}`)].join('\n')}\n`;
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

/**
 * Whether every repo with a `pipeline_ref` record still has the tree of the commit CI ran on.
 * Null when no repo has a record, or a sha cannot be resolved here.
 */
export async function unchangedSincePipeline(refBody: string | null, mounts: SandboxMount[]): Promise<boolean | null> {
  const records = parsePipelineRefs(refBody ?? '');
  let compared = false;
  for (const mount of mounts) {
    const origin = await quietGit(mount.hostPath, ['remote', 'get-url', 'origin']).catch(() => '');
    const project = origin ? safeProject(origin.trim()) : null;
    const sha = records.find((record) => record.project === project)?.sha;
    if (!project || !sha) {
      continue;
    }
    const pipelineTree = await quietGit(mount.hostPath, ['rev-parse', `${sha}^{tree}`]).catch(() => null);
    const current = await captureTree(mount.hostPath);
    if (!pipelineTree || !current) {
      return null;
    }
    compared = true;
    if (current.tree !== pipelineTree.trim()) {
      return false;
    }
  }
  return compared ? true : null;
}

/** The title of the activity that waits for the pipelines of a commit. */
export function ciTitle(records: PipelineRef[]): string {
  return `Wait for CI on ${records[0]?.sha?.slice(0, 7) ?? records[0]?.ref}`;
}

/** How the wait for CI came out, for its activity: `passed`, or `failed: <job>`. */
export function ciResult({ seen, verdict }: { seen: Seen[]; verdict: string }): string {
  if (verdict === 'green') {
    return 'passed';
  }
  if (verdict === 'red' && classify(seen) !== 'failed') {
    return `did not run: ${seen.find((item) => item.status === 'failed' || item.status === 'canceled')?.project ?? 'pipeline'}`;
  }
  const failed = seen.find((item) => item.status === 'failed');
  const job = failed?.jobs.find((item) => item.status === 'failed' && !item.allowFailure);
  return `failed: ${job?.name ?? failed?.project ?? 'pipeline'}`;
}

/** One line for each project: its pipeline status. */
export function jobResults(seen: Seen[]): string[] {
  return seen.map((item) => `${item.project}: ${item.status}`);
}

/** The line of a run that CI skipped. */
export function stopLine(seen: Seen[]): string {
  const project = seen.find((item) => item.status === 'skipped')?.project ?? 'pipeline';
  return `${project} pipeline was skipped`;
}

export function isRunning(item: Seen): boolean {
  return !['none', 'success', 'failed', 'canceled', 'skipped', 'manual'].includes(item.status);
}

/** The pipelines that keep running after a Stop, with their link. */
export function externalWork(seen: Seen[]): string[] {
  return seen.filter(isRunning).map((item) => `${item.project} pipeline ${item.id ?? '?'} ${item.url}`.trim());
}

export type Verdict = 'green' | 'red' | 'wait' | 'manual' | 'stop' | 'absent';

export function verdictOf(seen: Seen[]): Verdict {
  const statuses = seen.map((item) => item.status);
  if (statuses.includes('failed') || statuses.includes('canceled')) {
    return 'red';
  }
  if (statuses.includes('skipped')) {
    return 'stop';
  }
  if (statuses.includes('manual')) {
    return 'manual';
  }
  const active = statuses.filter((status) => status !== 'none');
  if (active.length === 0) {
    return 'absent';
  }
  if (active.some((status) => status !== 'success')) {
    return 'wait';
  }
  return 'green';
}
