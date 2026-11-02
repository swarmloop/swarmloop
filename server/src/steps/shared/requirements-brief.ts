import { jiraIssueKey } from '../../integrations/issue-tracker/jira/jira-url';

interface BriefNote {
  author?: string;
  body?: string;
}

interface BriefTicket {
  key?: string;
  summary?: string;
  description?: string;
  acceptanceCriteria?: string;
  comments?: BriefNote[];
}

interface BriefFile {
  name?: string;
  source?: string;
  url?: string | null;
  body?: string | null;
  encoding?: string;
}

interface BriefPage {
  title?: string;
  id?: string;
  url?: string;
  body?: string;
  encoding?: string;
}

interface BriefEpic {
  key?: string;
  summary?: string;
}

interface BriefRecord {
  tickets: BriefTicket[];
  prompt?: string;
  epic?: BriefEpic | null;
  epics?: BriefEpic[];
  files?: BriefFile[];
  pages?: BriefPage[];
}

/** The skills and follow-ups that read the requirements carry these two rules word for word. */
export const TASK_SCOPE =
  'The task is the Work tickets together with the Instructions. The Instructions add to the tickets. They do not replace them. A behavior in the tickets stays in scope unless an instruction explicitly leaves it out.';
export const LINKED_CONTEXT =
  'Linked tickets are context. They can change how the task is done. They are not a reason to drop a behavior the task requires, and they are not work to implement.';

/** Turns a requirements JSON record into the work-versus-context text agents read. */
export function requirementsBrief(raw: string): string {
  const record = parseRecord(raw);
  if (!record) {
    return raw;
  }
  const keys = record.tickets.map((ticket) => ticket.key?.trim() ?? '').filter((key) => key.length > 0);
  const lines = [keys.length > 0 ? `Work, and only this work: ${keys.join(', ')}.` : 'Work, and only this work.', TASK_SCOPE, LINKED_CONTEXT];
  const instructions = record.prompt?.trim() ?? '';
  if (instructions) {
    lines.push('', 'Instructions:', instructions);
  }
  lines.push('', 'Work:');
  for (const ticket of record.tickets) {
    lines.push('', ticketBlock(ticket));
  }
  for (const file of record.files ?? []) {
    const block = workFile(file);
    if (block) {
      lines.push('', block);
    }
  }
  const context = contextLines(record, new Set(keys));
  if (context.length > 0) {
    lines.push(
      '',
      'Context for this work only. It may change how the Work is planned and implemented. It is not a second task. Do not implement these tickets and do not review the diff against them.',
      ...context,
    );
  }
  const pages = record.pages ?? [];
  if (pages.length > 0) {
    lines.push('', 'Reference pages. These explain the work ticket. They are not a second task.');
    for (const page of pages) {
      lines.push('', pageBlock(page));
    }
  }
  return lines.join('\n');
}

function parseRecord(raw: string): BriefRecord | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return null;
    }
    const tickets = (value as { tickets?: unknown }).tickets;
    if (!Array.isArray(tickets)) {
      return null;
    }
    return value as BriefRecord;
  } catch {
    return null;
  }
}

function ticketBlock(ticket: BriefTicket): string {
  const title = [ticket.key?.trim(), ticket.summary?.trim()].filter((part) => part).join(': ');
  const lines = [`## ${title}`];
  if (ticket.description?.trim()) {
    lines.push('', ticket.description.trim());
  }
  if (ticket.acceptanceCriteria?.trim()) {
    lines.push('', 'Acceptance criteria:', ticket.acceptanceCriteria.trim());
  }
  const comments = (ticket.comments ?? []).filter((comment) => comment.body?.trim());
  if (comments.length > 0) {
    lines.push('', 'Comments:');
    for (const comment of comments) {
      lines.push(`- ${comment.author?.trim() || 'unknown'}: ${comment.body?.trim()}`);
    }
  }
  return lines.join('\n');
}

function workFile(file: BriefFile): string | null {
  if (file.source !== 'attachment' && file.source !== 'paste') {
    return null;
  }
  const label = file.source === 'attachment' ? 'Attachment' : 'Pasted';
  const name = (file.name || file.url || '').trim();
  const body = (file.body ?? '').trim();
  return body ? `${label} ${name}:\n${body}` : `${label} ${name}:`;
}

function contextLines(record: BriefRecord, workKeys: Set<string>): string[] {
  const lines: string[] = [];
  const epics = record.epics?.length ? record.epics : record.epic ? [record.epic] : [];
  for (const epic of epics) {
    const key = epic.key?.trim();
    if (!key) {
      continue;
    }
    lines.push(`- Epic ${key}: ${epic.summary?.trim() ?? ''}`.trimEnd());
  }
  const seen = new Set<string>();
  for (const file of record.files ?? []) {
    if (file.source === 'attachment' || file.source === 'paste') {
      continue;
    }
    const line = contextFile(file, workKeys);
    if (!line || seen.has(line)) {
      continue;
    }
    seen.add(line);
    lines.push(line);
  }
  return lines;
}

function contextFile(file: BriefFile, workKeys: Set<string>): string | null {
  const url = file.url?.trim() ?? '';
  const key = url ? jiraIssueKey(url) : null;
  if (key) {
    if (workKeys.has(key)) {
      return null;
    }
    const summary = issueSummary(file.body ?? '', key);
    const head = summary ? `- ${key}: ${summary}` : `- ${key}`;
    const rest = linkedRest(file.body ?? '', key);
    return rest ? `${head}\n${rest}` : head;
  }
  if (isHtml(file.body ?? '') || file.encoding === 'base64') {
    return url ? `- ${url}` : null;
  }
  const body = (file.body ?? '').trim();
  if (!body) {
    return url ? `- ${url}` : null;
  }
  return url ? `- ${url}\n${body}` : body;
}

function issueSummary(body: string, key: string): string {
  const lines = body.split('\n');
  if (lines[0]?.trim().toUpperCase() !== key) {
    return '';
  }
  return lines[1]?.trim() ?? '';
}

function linkedRest(body: string, key: string): string {
  const lines = body.split('\n');
  let start = lines[0]?.trim().toUpperCase() === key ? 1 : 0;
  if (lines[start]?.trim()) {
    start += 1;
  }
  while (start < lines.length && lines[start]?.trim() === '') {
    start += 1;
  }
  return lines.slice(start).join('\n').trim();
}

function isHtml(body: string): boolean {
  const start = body.trimStart().slice(0, 32).toLowerCase();
  return start.startsWith('<!doctype') || start.startsWith('<html');
}

function pageBlock(page: BriefPage): string {
  const lines = [`## ${page.title?.trim() || page.id?.trim() || 'page'}`];
  if (page.url?.trim()) {
    lines.push(page.url.trim());
  }
  if (page.encoding === 'base64') {
    return lines.join('\n');
  }
  const body = page.body?.trim() ?? '';
  if (body) {
    lines.push(body);
  }
  return lines.join('\n');
}
