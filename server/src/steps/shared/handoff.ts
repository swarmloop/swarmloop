import { HistoryService } from '../../history/history.service';
import { DocumentDraft } from '../../history/visit';

export function textDocument(kind: string, body: string): DocumentDraft {
  return { kind, fileName: '', body };
}

export function returnNotes(parts: { source: string; body: string }[]): DocumentDraft {
  return textDocument('return', `${parts.map((part) => `## ${part.source}\n${part.body.trimEnd()}`).join('\n\n')}\n`);
}

export function mergeHandoff(previous: string | null, step: string, body: string): string {
  const chunk = `## ${step}\n${body.trimEnd()}\n`;
  const sections = splitHandoff(previous ?? '');
  const next = { step, body: chunk };
  const index = sections.findIndex((item) => item.step === step);
  if (index >= 0) {
    sections[index] = next;
  } else {
    sections.push(next);
  }
  return `${sections.map((item) => item.body.trimEnd()).join('\n\n')}\n`;
}

export function withHandoff(
  sections: { heading: string; body: string }[],
  handoff: string | null,
): { heading: string; body: string }[] {
  return handoff?.trim() ? [...sections, { heading: 'What previous steps did', body: handoff }] : sections;
}

export async function recordHandoff(history: HistoryService, key: string, step: string, body: string): Promise<DocumentDraft> {
  return textDocument('handoff', mergeHandoff(await history.latestBody(key, 'handoff'), step, body));
}

export function handoffSection(text: string | null, step: string): string {
  const found = splitHandoff(text ?? '').find((item) => item.step === step);
  if (!found) {
    return '';
  }
  return found.body.replace(/^## [^\n]*\n/, '').trim();
}

function splitHandoff(text: string): { step: string; body: string }[] {
  return text
    .split(/^## /m)
    .filter((part) => part.trim())
    .map((part) => {
      const newline = part.indexOf('\n');
      const step = (newline === -1 ? part : part.slice(0, newline)).trim();
      return { step, body: `## ${part.trimEnd()}\n` };
    });
}

export function composedReturn(documents: { kind: string; body: string }[]): string | null {
  const latest = (kind: string): string | null => [...documents].reverse().find((item) => item.kind === kind)?.body ?? null;
  const stored = latest('return');
  if (stored?.trim()) {
    return stored;
  }
  const parts: { source: string; body: string }[] = [];
  for (const source of ['requirements', 'quality', 'regressions', 'security', 'performance']) {
    const body = latest(`review_${source}`);
    if (body && hasLine(body, 'decision: return')) {
      parts.push({ source, body });
    }
  }
  const pipeline = latest('pipeline_log');
  if (pipeline && hasLine(pipeline, 'result: fail')) {
    parts.push({ source: 'pipeline', body: pipeline });
  }
  return parts.length > 0 ? returnNotes(parts).body : null;
}

function hasLine(body: string, line: string): boolean {
  return body.split(/\r?\n/).some((item) => item.trim() === line);
}
