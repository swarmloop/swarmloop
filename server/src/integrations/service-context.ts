import { join } from 'path';
import { Inject, Injectable } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { DocumentRepository } from '../history/document.repository';
import { root } from '../history/run-paths';
import type { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { codeHostLabel } from './code-host/code-host-rules';
import { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import { IssueBundle } from '../integrations/issue-tracker/issue-bundle';
import { IssueTracker, runKeys } from '../integrations/issue-tracker/issue-tracker';
import { ISSUE_TRACKER } from '../integrations/issue-tracker/tokens';

@Injectable()
export class ServiceContextService {
  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly config: AppConfig,
    @Inject(ISSUE_TRACKER) private readonly tracker: IssueTracker,
    private readonly registry: CodeHostRegistry,
  ) {}

  /**
   * Ticket and merge-request text for a chat.
   * A key already stored on the requirements document is not fetched again.
   * Tokens stay in the host client.
   */
  async block(key: string, text: string): Promise<string> {
    const stored = (await this.documents.latestBody(key, 'requirements')) ?? '';
    const run = await this.runs.findRun(key);
    const login = run?.startedBy;
    const known = new Set(await this.tracker.ticketKeys(stored, login));
    const parts: string[] = [];
    for (const issue of await runKeys(this.tracker, key, text, login)) {
      if (known.has(issue)) {
        continue;
      }
      const note = await this.issue(key, issue, login);
      if (note) {
        parts.push(note);
      }
    }
    const mergeRequest = await this.mergeRequest(key, run);
    if (mergeRequest) {
      parts.push(mergeRequest);
    }
    if (parts.length === 0) {
      return '';
    }
    return ['Services:', 'Read these notes. Do not call the issue tracker or the code host yourself.', ...parts].join(
      '\n',
    );
  }

  private async issue(runKey: string, issue: string, login?: string | null): Promise<string | null> {
    try {
      const fetched = await this.tracker.fetch(issue, join(root(this.config), 'worktrees', runKey), login);
      return renderIssue(fetched.bundle);
    } catch {
      return null;
    }
  }

  private async mergeRequest(key: string, run: RunEntity | null): Promise<string | null> {
    const saved = await this.documents.latestBody(key, 'merge_request');
    const stored = saved ? storedMerge(saved) : null;
    if (stored) {
      return stored;
    }
    if (!run?.codeHost) {
      return null;
    }
    const host = (await this.registry.forRun(run.startedBy, run.codeHost)).byName(run.codeHost);
    const label = codeHostLabel(run.codeHost) ?? run.codeHost;
    const body = await this.documents.latestBody(key, 'pipeline_ref');
    const lines: string[] = [];
    for (const ref of body ? pipelineRefs(body) : []) {
      try {
        const found = await host.findMergeRequest({ project: ref.project, source: ref.ref });
        if (found.record) {
          lines.push(`${label} ${found.record.project} !${found.record.iid} ${found.record.url}`);
        }
      } catch {
        break;
      }
    }
    return lines.length > 0 ? lines.join('\n') : null;
  }
}

function renderIssue(bundle: IssueBundle): string {
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
