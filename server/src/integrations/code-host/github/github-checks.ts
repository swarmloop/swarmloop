import { SwarmloopError } from '../../../core/swarmloop-error';
import type { CheckAnnotation, PipelineCheck, PipelineJob } from '../code-host';

export interface GithubRun {
  id?: number;
  name?: string;
  event?: string;
  pull_requests?: unknown[];
  head_sha?: string;
  status?: string;
  conclusion?: string | null;
  html_url?: string;
  check_suite_id?: number;
  message?: string;
}

interface GithubCheckRun extends GithubRun {
  app?: { name?: string };
  check_suite?: { id?: number };
  started_at?: string | null;
  completed_at?: string | null;
  output?: { summary?: string | null };
}

interface GithubStatus {
  id?: number;
  state?: string;
  context?: string;
  description?: string | null;
  target_url?: string | null;
  creator?: { login?: string };
}

interface GithubAnnotation {
  path?: string;
  start_line?: number;
  annotation_level?: string;
  title?: string | null;
  message?: string;
}

type Read = (url: string) => Promise<unknown>;

const SCANNING = 'Code scanning results';
const MAX_PAGES = 50;

export function checkStatus(row: GithubRun): PipelineCheck['status'] {
  if (row.status !== 'completed') {
    return 'running';
  }
  if (row.conclusion === 'success' || row.conclusion === 'neutral') {
    return 'success';
  }
  if (row.conclusion === 'cancelled') {
    return 'canceled';
  }
  if (row.conclusion === 'skipped') {
    return 'skipped';
  }
  return row.conclusion === 'action_required' ? 'manual' : 'failed';
}

/** The runs of one commit: those of `sha`, or of the newest run's commit when there is no sha. */
export function runsOf(body: unknown, sha: string): GithubRun[] {
  const rows = (body as { workflow_runs?: unknown } | null)?.workflow_runs;
  if (!Array.isArray(rows)) {
    throw new SwarmloopError('github pipeline failed');
  }
  const runs = (rows as (GithubRun | null)[]).filter((run): run is GithubRun => Boolean(run?.id));
  const head = sha || runs[0]?.head_sha;
  return runs.filter((run) => !head || run.head_sha === head);
}

/** CodeQL default setup starts its `Code scanning results` check on a pull request after its own run has ended. */
export function awaitedChecks(runs: GithubRun[], checks: PipelineCheck[]): string[] {
  const dynamic = runs.find(
    (run) => run.event === 'dynamic' && run.name === 'CodeQL' && (run.pull_requests?.length ?? 0) > 0,
  );
  const waiting = dynamic && checkStatus(dynamic) === 'success' && !checks.some((c) => c.name.startsWith(SCANNING));
  return waiting ? [SCANNING] : [];
}

/** Every page of a list; a short page is the last one. */
async function readPages(
  read: Read,
  url: string,
  size: number,
  rowsOf: (body: unknown) => unknown[],
): Promise<unknown[]> {
  const rows: unknown[] = [];
  const joiner = url.includes('?') ? '&' : '?';
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = rowsOf(await read(`${url}${joiner}per_page=${size}&page=${page}`));
    rows.push(...batch);
    if (batch.length < size) {
      break;
    }
  }
  return rows;
}

function listOf(key: string): (body: unknown) => unknown[] {
  return (body) => {
    const rows = (body as Record<string, unknown> | null)?.[key];
    return Array.isArray(rows) ? (rows as unknown[]) : [];
  };
}

function checkRun(row: GithubCheckRun, runs: GithubRun[]): PipelineCheck {
  const workflow = runs.find((run) => run.check_suite_id !== undefined && run.check_suite_id === row.check_suite?.id);
  const started = Date.parse(row.started_at ?? '');
  const ended = Date.parse(row.completed_at ?? '');
  return {
    id: row.id ?? 0,
    name: workflow ? `${workflow.name ?? 'workflow'} / ${row.name ?? ''}` : (row.name ?? ''),
    app: row.app?.name ?? '',
    status: checkStatus(row),
    durationMs: ended >= started ? ended - started : 0,
    url: row.html_url ?? '',
    summary: '',
    annotations: [],
    workflow: workflow !== undefined,
  };
}

function commitStatus(row: GithubStatus): PipelineCheck {
  const failed = row.state === 'failure' || row.state === 'error';
  return {
    id: row.id ?? 0,
    name: row.context ?? '',
    app: row.creator?.login ?? 'commit status',
    status: failed ? 'failed' : row.state === 'success' ? 'success' : 'running',
    durationMs: 0,
    url: row.target_url ?? '',
    summary: failed ? (row.description ?? '') : '',
    annotations: [],
    workflow: false,
  };
}

async function annotated(read: Read, repo: string, check: PipelineCheck, summary: string): Promise<PipelineCheck> {
  const rows = await readPages(read, `${repo}/check-runs/${check.id}/annotations`, 50, (body) =>
    Array.isArray(body) ? (body as unknown[]) : [],
  );
  const annotations = (rows as GithubAnnotation[]).map((row): CheckAnnotation => ({
    path: row.path ?? '',
    line: row.start_line ?? 0,
    level: row.annotation_level ?? '',
    title: row.title ?? '',
    message: row.message ?? '',
  }));
  return { ...check, summary, annotations };
}

/** Every check run (latest per name) and commit status of `sha`; a failed app check comes with its annotations. */
export async function readChecks(read: Read, repo: string, sha: string, runs: GithubRun[]): Promise<PipelineCheck[]> {
  const commit = `${repo}/commits/${encodeURIComponent(sha)}`;
  const rows = (await readPages(
    read,
    `${commit}/check-runs?filter=latest`,
    100,
    listOf('check_runs'),
  )) as GithubCheckRun[];
  const statuses = (await readPages(read, `${commit}/status`, 100, listOf('statuses'))) as GithubStatus[];
  const checks: PipelineCheck[] = [];
  for (const row of rows) {
    const check = checkRun(row, runs);
    const failed = !check.workflow && check.status === 'failed';
    checks.push(failed ? await annotated(read, repo, check, row.output?.summary ?? '') : check);
  }
  return [...checks, ...statuses.map(commitStatus)];
}

export function listJobs(status: string, jobs: boolean): boolean {
  if (status === 'running') {
    return jobs;
  }
  return status === 'success' || status === 'failed' || status === 'canceled';
}

export function asJob(row: unknown): PipelineJob | null {
  const job = row as { id?: number; name?: string; conclusion?: string | null; status?: string } | null;
  if (!job?.id) {
    return null;
  }
  const done: Record<string, string> = {
    failure: 'failed',
    timed_out: 'timed_out',
    cancelled: 'canceled',
    startup_failure: 'startup_failure',
  };
  const finished = job.conclusion ? done[job.conclusion] : undefined;
  if (finished) {
    return { id: job.id, name: job.name ?? String(job.id), stage: '', status: finished, allowFailure: false };
  }
  if (job.status && job.status !== 'completed') {
    return { id: job.id, name: job.name ?? String(job.id), stage: '', status: job.status, allowFailure: false };
  }
  return null;
}
