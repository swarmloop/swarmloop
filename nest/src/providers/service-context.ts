import { join } from 'path';
import { Inject, Injectable } from '@nestjs/common';
import { HistoryService } from '../history/history.service';
import { taskKeys } from '../steps/requirements/requirements.service';
import { IssueBundle } from './issue-bundle';
import { CodeHosts } from './code-hosts';
import { IssueTracker } from './contracts';
import { ISSUE_TRACKER } from './tokens';

@Injectable()
export class ServiceContextService {
  constructor(
    private readonly history: HistoryService,
    @Inject(ISSUE_TRACKER) private readonly tracker: IssueTracker,
    private readonly hosts: CodeHosts,
  ) {}

  /**
   * Ticket and merge-request text for a chat.
   * A key already stored on the requirements document is not fetched again.
   * Tokens stay in the host client.
   */
  async block(key: string, text: string): Promise<string> {
    const stored = (await this.history.latestBody(key, 'requirements')) ?? '';
    const known = new Set(taskKeys(stored, ''));
    const parts: string[] = [];
    for (const issue of taskKeys(text, key)) {
      if (known.has(issue)) {
        continue;
      }
      const note = await this.issue(key, issue);
      if (note) {
        parts.push(note);
      }
    }
    const gitlab = await this.mergeRequest(key);
    if (gitlab) {
      parts.push(gitlab);
    }
    if (parts.length === 0) {
      return '';
    }
    return ['Services:', 'Read these host notes. Do not call Jira or GitLab yourself.', ...parts].join('\n');
  }

  private async issue(runKey: string, issue: string): Promise<string | null> {
    try {
      const fetched = await this.tracker.fetch(issue, join(this.history.root(), 'worktrees', runKey));
      return renderIssue(fetched.bundle);
    } catch {
      return null;
    }
  }

  private async mergeRequest(key: string): Promise<string | null> {
    const saved = await this.history.latestBody(key, 'merge_request');
    const stored = saved ? storedMerge(saved) : null;
    if (stored) {
      return stored;
    }
    const run = await this.history.findRun(key);
    if (!run?.codeHost) {
      return null;
    }
    const host = this.hosts.get(run.codeHost);
    const body = await this.history.latestBody(key, 'pipeline_ref');
    const lines: string[] = [];
    for (const ref of body ? pipelineRefs(body) : []) {
      try {
        const found = await host.findMergeRequest({ project: ref.project, source: ref.ref });
        if (found.record) {
          lines.push(`${codeHostLabel(found.record.url)} ${found.record.project} !${found.record.iid} ${found.record.url}`);
        }
      } catch {
        break;
      }
    }
    return lines.length > 0 ? lines.join('\n') : null;
  }
}

export function renderIssue(bundle: IssueBundle): string {
  const lines = [`Jira ${bundle.key}: ${bundle.summary.trim()}`, bundle.descriptionMarkdown.trim()];
  if (bundle.acceptanceCriteria.trim()) {
    lines.push(`Acceptance: ${bundle.acceptanceCriteria.trim()}`);
  }
  return lines.filter((line) => line.trim().length > 0).join('\n');
}

export function pipelineRefs(body: string): { project: string; ref: string }[] {
  const found: { project: string; ref: string }[] = [];
  let project = '';
  let ref = '';
  const flush = (): void => {
    if (project && ref) {
      found.push({ project, ref });
    }
    project = '';
    ref = '';
  };
  for (const line of body.split('\n')) {
    if (line.startsWith('project:')) {
      flush();
      project = line.slice('project:'.length).trim();
    } else if (line.startsWith('ref:')) {
      ref = line.slice('ref:'.length).trim();
    } else if ((line.startsWith('sha:') || line.trim() === '') && project && ref) {
      flush();
    }
  }
  flush();
  return found;
}

export function pipelineRef(body: string): { project: string; ref: string } | null {
  return pipelineRefs(body)[0] ?? null;
}

function codeHostLabel(url: string): string {
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === 'github.com' || host.endsWith('.github.com') || host.endsWith('.ghe.com') || host.includes('github')) {
      return 'GitHub';
    }
  } catch {
    return 'GitLab';
  }
  return 'GitLab';
}

function storedMerge(body: string): string | null {
  const lines = body
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('project:') || line.startsWith('iid:') || line.startsWith('url:'));
  if (lines.length === 0) {
    return null;
  }
  return lines.join('\n');
}
