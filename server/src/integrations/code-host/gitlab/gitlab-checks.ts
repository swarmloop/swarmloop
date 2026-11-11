import type { PipelineCheck, PipelineJob } from '../code-host';

export interface GitlabJob {
  id?: number;
  name?: string;
  stage?: string;
  status?: string;
  allow_failure?: boolean;
  retried?: boolean;
  duration?: number | null;
  web_url?: string;
}

/** A commit status that an external app posted (`description` is its text). */
export interface GitlabStatus extends GitlabJob {
  description?: string | null;
  target_url?: string | null;
  author?: { name?: string };
}

/** The status of a pipeline, reduced to the statuses the step knows. Anything not final is running. */
export function pipelineStatus(raw: string | undefined): string {
  if (raw === 'success' || raw === 'failed' || raw === 'skipped' || raw === 'manual') {
    return raw;
  }
  return raw === 'canceled' || raw === 'cancelled' ? 'canceled' : 'running';
}

export function jobScopes(status: string): string[] | null {
  if (status === 'success') {
    return ['failed'];
  }
  if (status === 'failed' || status === 'canceled') {
    return ['failed', 'canceled', 'created', 'pending', 'waiting_for_resource'];
  }
  if (status === 'skipped' || status === 'manual' || status === '') {
    return null;
  }
  return ['running', 'pending'];
}

export function asJob(row: unknown): PipelineJob | null {
  const job = row as GitlabJob | null;
  if (!job?.id || job.retried === true) {
    return null;
  }
  const canceled = job.status === 'canceled' || job.status === 'cancelled';
  const status = canceled ? 'canceled' : (job.status ?? 'failed');
  if (status === 'success' || status === 'skipped' || status === 'manual') {
    return null;
  }
  return {
    id: job.id,
    name: job.name ?? String(job.id),
    stage: job.stage ?? '',
    status,
    allowFailure: canceled ? false : job.allow_failure === true,
  };
}

const FINAL: Record<string, PipelineCheck['status']> = {
  success: 'success',
  canceled: 'canceled',
  cancelled: 'canceled',
  skipped: 'skipped',
};

/** Green is success, skipped, a manual job nobody needs, or a failure the job allows. */
function checkState(row: GitlabJob): PipelineCheck['status'] {
  const allowed = row.allow_failure === true;
  if (row.status === 'failed') {
    return allowed ? 'success' : 'failed';
  }
  if (row.status === 'manual') {
    return allowed ? 'skipped' : 'manual';
  }
  return FINAL[row.status ?? ''] ?? 'running';
}

export function jobCheck(row: GitlabJob): PipelineCheck {
  return {
    id: row.id ?? 0,
    name: row.name ?? String(row.id),
    app: 'GitLab CI',
    status: checkState(row),
    durationMs: Math.round((row.duration ?? 0) * 1000),
    url: row.web_url ?? '',
    summary: '',
    annotations: [],
    workflow: true,
  };
}

export function statusCheck(row: GitlabStatus): PipelineCheck {
  return {
    ...jobCheck(row),
    app: row.author?.name ?? 'external status',
    url: row.target_url ?? '',
    summary: row.description ?? '',
    workflow: false,
  };
}
