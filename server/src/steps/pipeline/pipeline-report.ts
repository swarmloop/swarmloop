import type { PipelineJob, PipelineRef } from '../../integrations/code-host/code-host';
import { readableJobTrace } from './job-trace';

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
