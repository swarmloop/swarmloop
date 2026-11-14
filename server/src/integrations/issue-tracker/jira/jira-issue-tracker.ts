import { Injectable } from '@nestjs/common';
import { basename } from 'path';
import { AppConfig } from '../../../config/env';
import { Clock } from '../../../core/clock';
import { request } from '../../http';
import { ERROR_CODES } from '../../../contract/error-codes';
import {
  FetchFailed,
  HostUnavailable,
  HttpCallDraft,
  IssueNotFound,
  SwarmloopError,
} from '../../../core/swarmloop-error';
import { encodedBody, headersFor, LinkedPagesService } from '../../linked-pages/linked-pages';
import { AbstractIssueTracker } from '../abstract-issue-tracker';
import { IssueBundle } from '../issue-bundle';
import { adfToMarkdown, collectUrls } from './adf';
import { jiraConfigured, JiraTicketKeys } from './jira-ticket-keys';
import { JiraComment, JiraIssue, JiraLinks, textValue, toNote } from './jira-links';

interface JiraField {
  id: string;
  name: string;
}

@Injectable()
export class JiraIssueTracker extends AbstractIssueTracker {
  private readonly keys: JiraTicketKeys;
  private readonly linkFollower: JiraLinks;

  constructor(
    private readonly config: AppConfig,
    private readonly linkedPages: LinkedPagesService,
    private readonly clock: Clock,
  ) {
    super();
    this.keys = new JiraTicketKeys(config, clock, () => this.credentials());
    this.linkFollower = new JiraLinks(
      (base, headers, key, calls) => this.issue(base, headers, key, calls),
      (base, headers, key, calls, urls) => this.comments(base, headers, key, calls, urls),
      linkedPages,
      clock,
    );
  }

  ticketKeys(text: string): Promise<string[]> {
    return this.keys.find(text);
  }

  protected async loadIssue(key: string, runDir: string, calls: HttpCallDraft[]): Promise<IssueBundle> {
    const { base, headers } = this.credentials();
    const fields = await this.fieldList(base, headers, calls);
    const acceptanceId = fields.find((field) => /acceptance criteria/i.test(field.name))?.id ?? null;
    const issue = await this.issue(base, headers, key, calls);
    const urls = new Set<string>();
    collectUrls(issue.fields.description, urls);
    const epic = await this.epic(base, headers, issue, calls, urls);
    const comments = await this.comments(base, headers, key, calls, urls);
    const attachments = await this.attachments(issue, headers, base, calls);
    const acceptance = acceptanceId ? textValue(issue.fields[acceptanceId]) : '';
    const bundle: IssueBundle = {
      key: issue.key,
      summary: issue.fields.summary ?? '',
      descriptionMarkdown: adfToMarkdown(issue.fields.description),
      acceptanceCriteria: acceptance,
      epic,
      comments: comments.map(toNote),
      attachments,
      links: [],
      confluence: [],
      pages: [],
    };
    await this.linkFollower.links(bundle, urls, issue, base, headers, basename(runDir), calls, acceptanceId);
    return bundle;
  }

  private credentials(): { base: string; headers: Record<string, string> } {
    const env = this.config.env;
    if (!jiraConfigured(env)) {
      throw new SwarmloopError(
        'this run id is a Jira key, but JIRA_BASE_URL, JIRA_EMAIL and JIRA_API_TOKEN are not set',
        { code: ERROR_CODES.INPUT_MISSING, category: 'user' },
      );
    }
    const token = Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64');
    return {
      base: env.JIRA_BASE_URL.replace(/\/$/, ''),
      headers: { Authorization: `Basic ${token}`, Accept: 'application/json' },
    };
  }

  private async fieldList(base: string, headers: Record<string, string>, calls: HttpCallDraft[]): Promise<JiraField[]> {
    const response = await request(this.clock, `${base}/rest/api/3/field`, headers, calls);
    if (response.status < 200 || response.status >= 300) {
      return [];
    }
    return JSON.parse(response.body.toString('utf8')) as JiraField[];
  }

  private async issue(
    base: string,
    headers: Record<string, string>,
    key: string,
    calls: HttpCallDraft[],
  ): Promise<JiraIssue> {
    const url = `${base}/rest/api/3/issue/${encodeURIComponent(key)}?fields=*all`;
    let response: Awaited<ReturnType<typeof request>>;
    try {
      response = await request(this.clock, url, headers, calls);
    } catch (error) {
      throw error instanceof HostUnavailable ? error : notFoundOr(key, 'failed', calls);
    }
    if (response.status < 200 || response.status >= 300) {
      throw notFoundOr(key, response.status, calls);
    }
    return JSON.parse(response.body.toString('utf8')) as JiraIssue;
  }

  private async epic(
    base: string,
    headers: Record<string, string>,
    issue: JiraIssue,
    calls: HttpCallDraft[],
    urls: Set<string>,
  ): Promise<IssueBundle['epic']> {
    let parentKey = issue.fields.parent?.key;
    const seen = new Set<string>([issue.key]);
    let epic: JiraIssue | null = null;
    while (parentKey && !seen.has(parentKey) && seen.size < 6) {
      seen.add(parentKey);
      const parent = await this.issue(base, headers, parentKey, calls);
      if (parent.fields.issuetype?.name?.toLowerCase() === 'epic') {
        epic = parent;
        collectUrls(parent.fields.description, urls);
        break;
      }
      collectUrls(parent.fields.description, urls);
      parentKey = parent.fields.parent?.key;
      epic = parent;
    }
    if (!epic) {
      return null;
    }
    const epicComments = await this.comments(base, headers, epic.key, calls, urls);
    return {
      key: epic.key,
      summary: epic.fields.summary ?? '',
      descriptionMarkdown: adfToMarkdown(epic.fields.description),
      comments: epicComments.map(toNote),
    };
  }

  private async comments(
    base: string,
    headers: Record<string, string>,
    key: string,
    calls: HttpCallDraft[],
    urls: Set<string>,
  ): Promise<JiraComment[]> {
    const all: JiraComment[] = [];
    let startAt = 0;
    for (;;) {
      const url = `${base}/rest/api/3/issue/${encodeURIComponent(key)}/comment?startAt=${startAt}&maxResults=100`;
      const response = await request(this.clock, url, headers, calls);
      if (response.status < 200 || response.status >= 300) {
        throw new FetchFailed(`issue fetch failed for ${key}: HTTP ${response.status}`, calls);
      }
      const page = JSON.parse(response.body.toString('utf8')) as { comments?: JiraComment[]; total?: number };
      const batch = page.comments ?? [];
      for (const comment of batch) {
        collectUrls(comment.body, urls);
      }
      all.push(...batch);
      startAt += batch.length;
      if (batch.length === 0 || startAt >= (page.total ?? startAt)) {
        break;
      }
    }
    return all;
  }

  private async attachments(
    issue: JiraIssue,
    headers: Record<string, string>,
    base: string,
    calls: HttpCallDraft[],
  ): Promise<IssueBundle['attachments']> {
    const saved: IssueBundle['attachments'] = [];
    for (const attachment of issue.fields.attachment ?? []) {
      if (!attachment.content || !attachment.filename) {
        continue;
      }
      const response = await request(
        this.clock,
        attachment.content,
        headersFor(attachment.content, base, headers),
        calls,
      );
      const encoded = encodedBody(response.contentType, response.body);
      saved.push({
        filename: attachment.filename,
        path: '',
        url: attachment.content,
        body: encoded.body,
        encoding: encoded.encoding,
      });
    }
    return saved;
  }
}

function notFoundOr(key: string, status: number | string, calls: HttpCallDraft[]): FetchFailed {
  const message = `issue fetch failed for ${key}: HTTP ${status}`;
  return status === 404 ? new IssueNotFound(message, calls) : new FetchFailed(message, calls);
}
