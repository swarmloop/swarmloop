import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { basename } from 'path';
import { Repository } from 'typeorm';
import { readEnv } from '../../config/env';
import { PasteEntity } from '../../history/entities';
import { adfToMarkdown, collectUrls } from '../adf';
import { driveTarget, loadDrive } from '../drive';
import { IssueBundle, IssueLink, IssueNote, IssuePage } from '../issue-bundle';
import { HttpStatusError, isReadable, request } from '../http';
import { sameSiteIssueKey } from './jira-url';
import { PASTE_READER, PasteReader } from '../tokens';
import { FetchFailed, HttpCallDraft, SwarmloopError, PasteNeeded } from '../../swarmloop-error';

const ISSUE_KEY = /^[A-Z][A-Z0-9]+-\d+$/;

interface JiraIssue {
  key: string;
  fields: {
    summary?: string;
    description?: unknown;
    status?: { name?: string; statusCategory?: { key?: string } };
    issuetype?: { name?: string };
    parent?: { key?: string };
    attachment?: { filename?: string; content?: string }[];
    comment?: { comments?: JiraComment[] };
    [key: string]: unknown;
  };
}

interface JiraComment {
  author?: { displayName?: string };
  created?: string;
  body?: unknown;
}

interface JiraField {
  id: string;
  name: string;
}

@Injectable()
export class JiraTrackerService {
  constructor(
    private readonly config: ConfigService,
    @Inject(PASTE_READER) private readonly pastes: PasteReader,
    @InjectRepository(PasteEntity) private readonly pasteRows: Repository<PasteEntity>,
  ) {}

  async fetch(key: string, runDir: string): Promise<{ bundle: IssueBundle; httpCalls: HttpCallDraft[] }> {
    const calls: HttpCallDraft[] = [];
    try {
      const bundle = await this.load(key, runDir, calls);
      return { bundle, httpCalls: calls };
    } catch (error) {
      if (error instanceof PasteNeeded) {
        throw new PasteNeeded(error.url, calls);
      }
      if (error instanceof FetchFailed) {
        throw error;
      }
      if (error instanceof SwarmloopError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'issue fetch failed';
      throw new FetchFailed(message, calls);
    }
  }

  private async load(key: string, runDir: string, calls: HttpCallDraft[]): Promise<IssueBundle> {
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
    await this.links(bundle, urls, issue, base, headers, basename(runDir), calls, acceptanceId);
    return bundle;
  }

  private credentials(): { base: string; headers: Record<string, string> } {
    const env = readEnv(this.config);
    const missing = (['JIRA_BASE_URL', 'JIRA_EMAIL', 'JIRA_API_TOKEN'] as const).find((name) => !env[name]);
    if (missing) {
      throw new SwarmloopError(`${missing} is missing`);
    }
    const token = Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64');
    return {
      base: env.JIRA_BASE_URL.replace(/\/$/, ''),
      headers: { Authorization: `Basic ${token}`, Accept: 'application/json' },
    };
  }

  private async fieldList(base: string, headers: Record<string, string>, calls: HttpCallDraft[]): Promise<JiraField[]> {
    const response = await request(`${base}/rest/api/3/field`, headers, calls);
    if (response.status < 200 || response.status >= 300) {
      return [];
    }
    return JSON.parse(response.body.toString('utf8')) as JiraField[];
  }

  private async issue(base: string, headers: Record<string, string>, key: string, calls: HttpCallDraft[]): Promise<JiraIssue> {
    const url = `${base}/rest/api/3/issue/${encodeURIComponent(key)}?fields=*all`;
    let response: Awaited<ReturnType<typeof request>>;
    try {
      response = await request(url, headers, calls);
    } catch (error) {
      const status = error instanceof HttpStatusError ? error.status : 'failed';
      throw new FetchFailed(`issue fetch failed for ${key}: HTTP ${status}`, calls);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new FetchFailed(`issue fetch failed for ${key}: HTTP ${response.status}`, calls);
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
      const response = await request(url, headers, calls);
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
      const response = await request(attachment.content, headersFor(attachment.content, base, headers), calls);
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

  private async links(
    bundle: IssueBundle,
    urls: Set<string>,
    issue: JiraIssue,
    base: string,
    headers: Record<string, string>,
    runKey: string,
    calls: HttpCallDraft[],
    acceptanceId: string | null,
  ): Promise<void> {
    const attachmentUrls = new Set((issue.fields.attachment ?? []).map((item) => item.content).filter((url): url is string => Boolean(url)));
    const stored = await this.savedPastes(runKey);
    const seen = new Set<string>([issue.key, bundle.epic?.key].filter((key): key is string => Boolean(key)));
    const direct: string[] = [];
    const remember = (key: string): void => {
      if (!seen.has(key) && !direct.includes(key)) {
        direct.push(key);
      }
    };
    for (const key of issueLinkKeys(issue)) {
      remember(key);
    }
    for (const url of urls) {
      if (attachmentUrls.has(url) || !/^https?:\/\//.test(url)) {
        continue;
      }
      const pageId = confluenceId(url, base);
      if (pageId) {
        bundle.confluence.push(await this.confluence(base, headers, pageId, url, calls));
        continue;
      }
      const drive = driveTarget(url);
      if (drive) {
        bundle.pages.push(await this.drive(url, calls));
        continue;
      }
      const linked = sameSiteIssueKey(url, base);
      if (linked) {
        remember(linked);
        continue;
      }
      bundle.links.push(...(await this.external(url, base, headers, runKey, calls, stored)));
    }
    for (const key of direct) {
      const loaded = await this.relatedIssue(bundle, key, base, headers, calls, acceptanceId, seen);
      if (!loaded) {
        continue;
      }
      for (const child of subtaskKeys(loaded)) {
        await this.relatedIssue(bundle, child, base, headers, calls, acceptanceId, seen);
      }
    }
  }

  private async relatedIssue(
    bundle: IssueBundle,
    key: string,
    base: string,
    headers: Record<string, string>,
    calls: HttpCallDraft[],
    acceptanceId: string | null,
    seen: Set<string>,
  ): Promise<JiraIssue | null> {
    if (seen.has(key)) {
      return null;
    }
    seen.add(key);
    try {
      const linked = await this.issue(base, headers, key, calls);
      const body = await this.relatedText(linked, base, headers, calls, acceptanceId);
      bundle.links.push({
        url: `${base}/browse/${linked.key}`,
        path: '',
        source: 'link',
        body,
        encoding: 'utf8',
      });
      return linked;
    } catch (error) {
      if (error instanceof FetchFailed) {
        return null;
      }
      throw error;
    }
  }

  private async relatedText(
    linked: JiraIssue,
    base: string,
    headers: Record<string, string>,
    calls: HttpCallDraft[],
    acceptanceId: string | null,
  ): Promise<string> {
    const comments = await this.comments(base, headers, linked.key, calls, new Set());
    const lines = [linked.key];
    const summary = (linked.fields.summary ?? '').trim();
    if (summary) {
      lines.push(summary);
    }
    const status = statusText(linked);
    if (status) {
      lines.push('', `Status: ${status}`);
    }
    const description = adfToMarkdown(linked.fields.description).trim();
    if (description) {
      lines.push('', description);
    }
    const acceptance = acceptanceId ? textValue(linked.fields[acceptanceId]).trim() : '';
    if (acceptance) {
      lines.push('', 'Acceptance criteria:', acceptance);
    }
    if (comments.length > 0) {
      lines.push('', 'Comments:');
      for (const comment of comments) {
        const note = toNote(comment);
        if (note.bodyMarkdown.trim()) {
          lines.push(`- ${note.author}: ${note.bodyMarkdown.trim()}`);
        }
      }
    }
    return lines.join('\n');
  }

  private async confluence(
    base: string,
    headers: Record<string, string>,
    pageId: string,
    pageUrl: string,
    calls: HttpCallDraft[],
  ): Promise<IssuePage> {
    const url = `${base}/wiki/rest/api/content/${pageId}?expand=body.storage`;
    const response = await request(url, headers, calls);
    if (response.status < 200 || response.status >= 300) {
      throw new FetchFailed(`confluence is not readable: ${pageUrl}`, calls);
    }
    const raw = response.body.toString('utf8');
    const page = JSON.parse(raw) as { title?: string; body?: { storage?: { value?: string } } };
    return {
      source: 'confluence',
      id: pageId,
      title: page.title ?? pageId,
      path: '',
      url: pageUrl,
      body: page.body?.storage?.value ?? raw,
      encoding: 'utf8',
    };
  }

  private async drive(url: string, calls: HttpCallDraft[]): Promise<IssuePage> {
    try {
      const loaded = await loadDrive(url, (exportUrl) => request(exportUrl, { Accept: '*/*' }, calls));
      return {
        source: 'drive',
        id: loaded.id,
        title: loaded.title,
        path: '',
        url,
        body: loaded.body,
        encoding: loaded.encoding,
      };
    } catch (error) {
      if (error instanceof FetchFailed) {
        throw error;
      }
      const message = error instanceof Error ? error.message : `drive is not readable: ${url}`;
      throw new FetchFailed(message, calls);
    }
  }

  private async external(
    url: string,
    base: string,
    headers: Record<string, string>,
    runKey: string,
    calls: HttpCallDraft[],
    stored: Record<string, string>,
  ): Promise<IssueLink[]> {
    const saved: IssueLink[] = [];
    const response = await request(url, headersFor(url, base, headers), calls);
    if (response.status >= 200 && response.status < 300 && response.body.length > 0) {
      if (isHtmlDocument(response.contentType, response.body)) {
        saved.push({ url, path: '', source: 'link', body: '', encoding: 'utf8' });
        return saved;
      }
      const readable = isReadable(response.contentType, response.body);
      const encoded = encodedBody(response.contentType, response.body);
      saved.push({ url, path: '', source: 'link', body: encoded.body, encoding: encoded.encoding });
      if (readable) {
        return saved;
      }
    }
    if (stored[url]) {
      saved.push({ url, path: '', source: 'paste', body: stored[url], encoding: 'utf8' });
      return saved;
    }
    const body = await this.pastes.read(url);
    await this.rememberPaste(runKey, url, body);
    stored[url] = body;
    saved.push({ url, path: '', source: 'paste', body, encoding: 'utf8' });
    return saved;
  }

  private async savedPastes(runKey: string): Promise<Record<string, string>> {
    const rows = await this.pasteRows.find({ where: { runKey } });
    const stored: Record<string, string> = {};
    for (const row of rows) {
      stored[row.url] = row.body;
    }
    return stored;
  }

  private async rememberPaste(runKey: string, url: string, body: string): Promise<void> {
    const existing = await this.pasteRows.findOne({ where: { runKey, url } });
    if (existing) {
      existing.body = body;
      await this.pasteRows.save(existing);
      return;
    }
    await this.pasteRows.save(this.pasteRows.create({ runKey, url, body }));
  }
}

function headersFor(url: string, base: string, auth: Record<string, string>): Record<string, string> {
  try {
    if (new URL(url).host === new URL(base).host) {
      return auth;
    }
  } catch {
    return { Accept: '*/*' };
  }
  return { Accept: '*/*' };
}

function confluenceId(url: string, base: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.host !== new URL(base).host) {
      return null;
    }
    return parsed.pathname.match(/\/pages\/(\d+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

/** Jira's status category keys. Status names are localized; these are not. */
const STATUS_CATEGORIES: Record<string, string> = { new: 'to do', indeterminate: 'in progress', done: 'done' };

function statusText(issue: JiraIssue): string {
  const name = issue.fields.status?.name?.trim() ?? '';
  const category = STATUS_CATEGORIES[issue.fields.status?.statusCategory?.key ?? ''] ?? '';
  if (name && category) {
    return `${name} (${category})`;
  }
  return name || category;
}

function issueLinkKeys(issue: JiraIssue): string[] {
  return nestedKeys(issue.fields.issuelinks, ['outwardIssue', 'inwardIssue']);
}

function subtaskKeys(issue: JiraIssue): string[] {
  return nestedKeys(issue.fields.subtasks, []);
}

function nestedKeys(value: unknown, nested: string[]): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const keys: string[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const record = item as Record<string, unknown>;
    pushKey(keys, record.key);
    for (const name of nested) {
      const child = record[name];
      if (child && typeof child === 'object') {
        pushKey(keys, (child as { key?: unknown }).key);
      }
    }
  }
  return keys;
}

function pushKey(keys: string[], value: unknown): void {
  if (typeof value === 'string' && ISSUE_KEY.test(value) && !keys.includes(value)) {
    keys.push(value);
  }
}

function toNote(comment: JiraComment): IssueNote {
  return {
    author: comment.author?.displayName ?? 'unknown',
    created: comment.created ?? '',
    bodyMarkdown: adfToMarkdown(comment.body),
  };
}

function isHtmlDocument(contentType: string | null, body: Buffer): boolean {
  if ((contentType ?? '').toLowerCase().includes('html')) {
    return true;
  }
  const start = body.subarray(0, 64).toString('utf8').trimStart().toLowerCase();
  return start.startsWith('<!doctype') || start.startsWith('<html');
}

function encodedBody(contentType: string | null, body: Buffer): { body: string; encoding: 'utf8' | 'base64' } {
  if (isReadable(contentType, body)) {
    return { body: body.toString('utf8'), encoding: 'utf8' };
  }
  return { body: body.toString('base64'), encoding: 'base64' };
}

function textValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (value && typeof value === 'object') {
    return adfToMarkdown(value);
  }
  return '';
}
