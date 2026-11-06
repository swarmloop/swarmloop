import type { DocumentRepository } from '../../history/document.repository';
import type { DocumentDraft } from '../../history/visit';
import { CODE_REVIEWERS } from '../../contract/steps';
import { ARTIFACTS, REVIEWS } from '../contract/artifacts';

export function textDocument(kind: string, body: string): DocumentDraft {
  return { kind, fileName: '', body };
}

export function returnNotes(parts: { source: string; body: string }[]): DocumentDraft {
  return textDocument(
    ARTIFACTS.return.kind,
    `${parts.map((part) => `## ${part.source}\n${part.body.trimEnd()}`).join('\n\n')}\n`,
  );
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

export async function recordHandoff(
  documents: DocumentRepository,
  key: string,
  step: string,
  body: string,
): Promise<DocumentDraft> {
  return textDocument(
    ARTIFACTS.handoff.kind,
    mergeHandoff(await documents.latestBody(key, ARTIFACTS.handoff.kind), step, body),
  );
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
  const latest = (kind: string): string | null =>
    [...documents].reverse().find((item) => item.kind === kind)?.body ?? null;
  const stored = latest(ARTIFACTS.return.kind);
  if (stored?.trim()) {
    return stored;
  }
  const parts: { source: string; body: string }[] = [];
  for (const source of CODE_REVIEWERS) {
    const body = latest(REVIEWS.of(source));
    if (body && hasLine(body, 'decision: return')) {
      parts.push({ source, body });
    }
  }
  const pipeline = latest(ARTIFACTS.pipelineLog.kind);
  if (pipeline && hasLine(pipeline, 'result: fail')) {
    parts.push({ source: 'pipeline', body: pipeline });
  }
  return parts.length > 0 ? returnNotes(parts).body : null;
}

/** The return notes of the run: the stored ones, or the ones its latest reviews and pipeline result call for. */
export async function returnedNotes(documents: DocumentRepository, runId: number): Promise<string | null> {
  return composedReturn(await documents.listDocuments(runId));
}

function hasLine(body: string, line: string): boolean {
  return body.split(/\r?\n/).some((item) => item.trim() === line);
}
