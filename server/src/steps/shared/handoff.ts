import { createHash } from 'node:crypto';
import type { DocumentRepository } from '../../history/document.repository';
import type { DocumentDraft } from '../../history/visit';
import { CODE_REVIEWERS } from '../../contract/steps';
import { ARTIFACTS, REVIEWS } from '../contract/artifacts';
import type { Issue } from '../contract/step-contract';

export function textDocument(kind: string, body: string): DocumentDraft {
  return { kind, fileName: '', body };
}

/** A problem sent back to a step. The same body from the same source always has the same id. */
export function issueOf(source: string, title: string, body: string): Issue {
  const digest = createHash('sha1').update(`${source}\n${body}`).digest('hex').slice(0, 10);
  return { id: `${source}-${digest}`, source, title, body };
}

export function returnNotes(parts: Pick<Issue, 'source' | 'body'>[]): DocumentDraft {
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

/** The open questions of a subtask, as the assumptions it records in its summary. */
export function assumptions(questions: string): string {
  return questions
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => `- assumed: ${line.replace(/^-\s*/, '')}`)
    .join('\n');
}

/** The `Contract` section a subtask's prompt carries: the decisions its parent holds right now. */
export function withContract(
  sections: { heading: string; body: string }[],
  contract: string | null,
): { heading: string; body: string }[] {
  return contract?.trim() ? [...sections, { heading: 'Contract', body: contract }] : sections;
}

/** A resumed session's prompt with the `Impact` section added at its end. */
export function appendImpact(prompt: string, impact: string | null): string {
  return impact?.trim() ? `${prompt}\n\nImpact:\n${impact.trimEnd()}` : prompt;
}

/** The `Impact` section a step's prompt carries. Left out when the list is empty. */
export function withImpact(
  sections: { heading: string; body: string }[],
  impact: string | null,
): { heading: string; body: string }[] {
  return impact?.trim() ? [...sections, { heading: 'Impact', body: impact }] : sections;
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

/** The return notes: the stored ones, else the latest issues, else the ones the latest reviews and pipeline result call for. */
export function composedReturn(documents: { kind: string; body: string }[]): string | null {
  const latest = (kind: string): string | null =>
    [...documents].reverse().find((item) => item.kind === kind)?.body ?? null;
  const stored = latest(ARTIFACTS.return.kind);
  if (stored?.trim()) {
    return stored;
  }
  const issues = ARTIFACTS.issues.parse(latest(ARTIFACTS.issues.kind) ?? '[]');
  if (issues.length > 0) {
    return returnNotes(issues).body;
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

/** The pipeline issues sent back to implement, and the ids of those it already answered without a change. */
export async function pipelineAnswers(
  documents: DocumentRepository,
  runId: number,
): Promise<{ issues: Issue[]; unfixed: Set<string> }> {
  const stored = await documents.listDocuments(runId);
  const latest = (kind: string): string => [...stored].reverse().find((item) => item.kind === kind)?.body ?? '';
  return {
    issues: ARTIFACTS.issues
      .parse(latest(ARTIFACTS.issues.kind) || '[]')
      .filter((issue) => issue.source === 'pipeline'),
    unfixed: new Set(latest(ARTIFACTS.unfixedIssue.kind).split('\n')),
  };
}

function hasLine(body: string, line: string): boolean {
  return body.split(/\r?\n/).some((item) => item.trim() === line);
}
