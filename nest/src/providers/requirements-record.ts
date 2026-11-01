import { RequirementsInput } from './contracts';
import { IssueBundle, IssueEpic, IssuePage } from '../integrations/issue-tracker/issue-bundle';

export interface RecordNote {
  author: string;
  created: string;
  body: string;
}

export interface RecordFile {
  name: string;
  path: string;
  source: 'attachment' | 'link' | 'paste';
  url: string | null;
  body: string | null;
  encoding: 'utf8' | 'base64';
}

export interface RecordPage {
  source: 'confluence' | 'drive';
  id: string;
  title: string;
  path: string;
  url: string;
  body: string;
  encoding: 'utf8' | 'base64';
}

export interface RecordEpic {
  key: string;
  summary: string;
  description: string;
  comments: RecordNote[];
}

export interface RecordTicket {
  key: string;
  summary: string;
  description: string;
  acceptanceCriteria: string;
  comments: RecordNote[];
}

export interface PlanFields {
  name: string;
  overview: string;
  items: string[];
  decision: 'approve' | 'revise' | null;
}

export interface RequirementsRecord {
  scope: string[];
  prompt: string | null;
  tickets: RecordTicket[];
  epic: RecordEpic | null;
  epics: RecordEpic[];
  files: RecordFile[];
  pages: RecordPage[];
  plan: PlanFields | null;
}

export function buildRecord(input: Pick<RequirementsInput, 'prompt' | 'bundles' | 'bundle' | 'issueKeys'>): RequirementsRecord {
  const bundles = input.issueKeys?.length ? (input.bundles?.length ? input.bundles : input.bundle ? [input.bundle] : []) : [];
  const epics = uniqueEpics(bundles);
  const tickets = bundles.map((bundle) => ({
    key: bundle.key,
    summary: bundle.summary,
    description: bundle.descriptionMarkdown,
    acceptanceCriteria: bundle.acceptanceCriteria,
    comments: bundle.comments.map(note),
  }));
  return {
    scope: tickets.map((ticket) => ticket.key),
    prompt: input.prompt ?? null,
    tickets,
    epic: epics[0] ?? null,
    epics,
    files: uniqueFiles(bundles),
    pages: uniquePages(bundles),
    plan: null,
  };
}

export function recordJson(record: RequirementsRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

function note(item: { author: string; created: string; bodyMarkdown: string }): RecordNote {
  return { author: item.author, created: item.created, body: item.bodyMarkdown };
}

function epicRecord(epic: IssueEpic): RecordEpic {
  return {
    key: epic.key,
    summary: epic.summary,
    description: epic.descriptionMarkdown,
    comments: epic.comments.map(note),
  };
}

function uniqueEpics(bundles: IssueBundle[]): RecordEpic[] {
  const seen = new Set<string>();
  const epics: RecordEpic[] = [];
  for (const bundle of bundles) {
    if (!bundle.epic || seen.has(bundle.epic.key)) {
      continue;
    }
    seen.add(bundle.epic.key);
    epics.push(epicRecord(bundle.epic));
  }
  return epics;
}

function uniqueFiles(bundles: IssueBundle[]): RecordFile[] {
  const seen = new Set<string>();
  const files: RecordFile[] = [];
  for (const bundle of bundles) {
    for (const file of bundle.attachments) {
      pushFile(seen, files, {
        name: file.filename,
        path: file.path,
        source: 'attachment',
        url: file.url,
        body: file.body,
        encoding: file.encoding,
      });
    }
    for (const link of bundle.links) {
      pushFile(seen, files, {
        name: link.path.split('/').pop() ?? link.url,
        path: link.path,
        source: link.source,
        url: link.url,
        body: link.body,
        encoding: link.encoding,
      });
    }
  }
  return files;
}

function pushFile(seen: Set<string>, files: RecordFile[], file: RecordFile): void {
  const key = file.path || `${file.source}:${file.url ?? ''}:${file.name}`;
  if (seen.has(key)) {
    return;
  }
  seen.add(key);
  files.push(file);
}

function uniquePages(bundles: IssueBundle[]): RecordPage[] {
  const seen = new Set<string>();
  const pages: RecordPage[] = [];
  for (const bundle of bundles) {
    for (const page of [...bundle.confluence, ...bundle.pages]) {
      const key = `${page.source}:${page.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      pages.push(pageRecord(page));
    }
  }
  return pages;
}

function pageRecord(page: IssuePage): RecordPage {
  return {
    source: page.source,
    id: page.id,
    title: page.title,
    path: page.path,
    url: page.url,
    body: page.body,
    encoding: page.encoding,
  };
}
