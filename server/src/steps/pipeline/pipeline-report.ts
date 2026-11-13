import type { AttemptCheck } from '../../contract/step-events';
import { issueOf } from '../shared/handoff';
import type { Issue } from '../contract/step-contract';
import type { PipelineCheck, PipelineJob, PipelineRef, PipelineRun } from '../../integrations/code-host/code-host';
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
  runs: PipelineRun[];
  checks: PipelineCheck[];
  awaiting: string[];
}

/** A workflow run or pipeline that the host can act on. */
export interface RunRow extends PipelineRun {
  project: string;
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
  /** The text of a check that no workflow ran: it is not a job log, so it is kept whole. */
  check?: true;
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
    return `${lines.join('\n')}\n\n${failure.check ? failure.trace : readableJobTrace(failure.trace)}`;
  });
  return `${head}result: fail\n${blocks.join('\n\n')}\n`;
}

export function cancelErrorNote(running: RunRow[], errors: string[]): string {
  const lines = ['result: fail'];
  for (const item of running) {
    lines.push(`project: ${item.project}`, `pipeline: ${item.id}`);
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
    return safeProject(await git(['-C', dir, 'remote', 'get-url', 'origin'], undefined, { answers: [2] }));
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

/** The checks of a commit that no workflow ran (code scanning, an external app) and whose status is in `counted`. */
export function appChecks(item: Seen, counted: string[]): PipelineCheck[] {
  return item.checks.filter((check) => !check.workflow && counted.includes(check.status));
}

/** The note of a wait that ended while app checks were still pending, or null when none were. */
export function pendingNote(seen: Seen[], minutes: number): string | null {
  const names = seen.flatMap((item) => appChecks(item, ['running']).map((check) => check.name));
  return names.length > 0 ? `${names.join(', ')} did not finish within ${minutes} minutes` : null;
}

/** Why a finished run is red: a failed job (or no job to tell), jobs that never ran, or only timed-out jobs. */
export function classify(seen: Seen[]): CiCause {
  const statuses = seen.flatMap((item) => item.runs.flatMap((run) => run.jobs.map((job) => job.status)));
  if (
    statuses.length === 0 ||
    statuses.includes('failed') ||
    seen.some((item) => appChecks(item, ['failed']).length > 0)
  ) {
    return 'failed';
  }
  return statuses.some((status) => NOT_RUN.includes(status)) ? 'not-run' : 'timeout';
}

/** The pipeline log of a run that did not run its jobs: one line with the code, then one `job:` line per job. */
export function renderInfra(code: InfraCode, seen: Seen[], notes: string): string {
  const unstarted = unstartedRuns(seen);
  if (unstarted.length > 0) {
    const lines = unstarted.map((run) => `${code}: CI host did not start run ${run.id} ${run.url}`.trim());
    return `${lines.join('\n')}\n`;
  }
  const wanted = code === 'CI_TIMEOUT' ? ['timed_out'] : NOT_RUN;
  const names = seen.flatMap((item) =>
    item.runs.flatMap((run) => run.jobs.filter((job) => wanted.includes(job.status)).map((job) => job.name)),
  );
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
  const check = seen.flatMap((item) => appChecks(item, ['failed']))[0];
  return `failed: ${job?.name ?? check?.name ?? failed?.project ?? 'pipeline'}`;
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

export function isRunning(status: string): boolean {
  return !['none', 'success', 'failed', 'canceled', 'skipped', 'manual'].includes(status);
}

/** The runs of every project whose status passes `test`. */
export function runRows(seen: Seen[], test: (status: string) => boolean): RunRow[] {
  return seen.flatMap((item) =>
    item.runs.filter((run) => test(run.status)).map((run) => ({ ...run, project: item.project })),
  );
}

/** The pipelines that keep running after a Stop, with their link. */
export function externalWork(seen: Seen[]): string[] {
  return runRows(seen, isRunning).map((run) => `${run.project} pipeline ${run.id} ${run.url}`.trim());
}

/** The runs the host accepted but has not started: queued, and without a job. */
export function unstartedRuns(seen: Seen[]): RunRow[] {
  return runRows(seen, isRunning).filter((run) => run.queued === true && run.total === 0);
}

const RUNNING_JOB = ['in_progress', 'running'];

/** What the wait is for right now, in words; null when nothing is awaited. */
export function waitingFor(seen: Seen[]): string | null {
  const running = runRows(seen, isRunning);
  const first = running[0];
  if (first) {
    const total = running.reduce((sum, run) => sum + (run.total ?? 0), 0);
    const active = running.reduce(
      (sum, run) => sum + run.jobs.filter((job) => RUNNING_JOB.includes(job.status)).length,
      0,
    );
    return `waiting for ci run ${first.id}: ${active} of ${total} jobs running`;
  }
  const names = seen.flatMap((item) => [...appChecks(item, ['running']).map((check) => check.name), ...item.awaiting]);
  return names.length > 0 ? `waiting for check ${names.join(', ')}` : null;
}

/** `unstarted` is the end of a wait on a run the CI host never started; only the wait itself decides it. */
export type Verdict = 'green' | 'red' | 'wait' | 'manual' | 'stop' | 'absent' | 'unstarted';

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
  if (active.some((status) => status !== 'success') || seen.some((item) => item.awaiting.length > 0)) {
    return 'wait';
  }
  return 'green';
}

/** The text of a check without a workflow: its summary, then one line per annotation. */
export function checkTrace(check: PipelineCheck): string {
  const lines = check.annotations.map(
    (note) => `${note.path}:${note.line} ${note.level} ${note.title ? `${note.title}: ` : ''}${note.message}`,
  );
  return [check.summary, ...lines].filter(Boolean).join('\n');
}

/** The checks of every project as step facts, or nothing when no host listed any. */
export function checkFacts(seen: Seen[]): { checks?: AttemptCheck[] } {
  const checks = seen.flatMap((item) =>
    item.checks.map(({ name, app, status, durationMs, url, annotations, summary }) => ({
      name,
      app,
      status,
      durationMs,
      url,
      annotations,
      summary,
    })),
  );
  return checks.length > 0 ? { checks } : {};
}
