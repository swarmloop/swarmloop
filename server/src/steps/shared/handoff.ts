import { createHash } from 'node:crypto';
import type { DocumentRepository } from '../../history/document.repository';
import type { DocumentDraft } from '../../history/visit';
import { CODE_REVIEWERS } from '../../contract/steps';
import type { Subtask } from '../../contract/subtask';
import { storedReview } from '../../agent-result/stored-review';
import { legacyHandoff, type HandoffEntry } from '../../agent-result/legacy/handoff';
import { ARTIFACTS, REVIEWS } from '../contract/artifacts';
import type { FailedCommand } from '../../environment/environment-types';
import type { Issue } from '../contract/step-contract';

export function textDocument(kind: string, body: string): DocumentDraft {
  return { kind, fileName: '', body };
}

/** The source of a CI problem that is not in the code. It is never sent back to an agent. */
export const CI_INFRA_SOURCE = 'ci-infra';

/** A problem sent back to a step. The same body from the same source always has the same id. */
export function issueOf(source: string, title: string, body: string, failed: FailedCommand[] = []): Issue {
  const digest = createHash('sha1').update(`${source}\n${body}`).digest('hex').slice(0, 10);
  return { id: `${source}-${digest}`, source, title, body, ...(failed.length > 0 ? { failed } : {}) };
}

export function returnNotes(parts: Pick<Issue, 'source' | 'body'>[]): DocumentDraft {
  return textDocument(
    ARTIFACTS.return.kind,
    `${parts.map((part) => `## ${part.source}\n${part.body.trimEnd()}`).join('\n\n')}\n`,
  );
}

function isEntry(item: unknown): item is HandoffEntry {
  const { step, body } = (item ?? {}) as Partial<Record<keyof HandoffEntry, unknown>>;
  return typeof step === 'string' && typeof body === 'string';
}

/** The stored handoff: JSON `[{step, body}]`, or the `## <step>` text of a run from before. */
function readHandoff(stored: string | null): HandoffEntry[] {
  if (!stored?.trim()) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(stored);
    if (Array.isArray(parsed) && parsed.every(isEntry)) {
      return parsed;
    }
  } catch {
    // not JSON: a handoff written before
  }
  return legacyHandoff(stored);
}

/** The handoff as the `## <step>` blocks a prompt and the dashboard show. Empty when there is none. */
export function handoffText(stored: string | null): string {
  const entries = readHandoff(stored);
  return entries.map((item) => `## ${item.step}\n${item.body}\n`).join('\n');
}

export function mergeHandoff(previous: string | null, step: string, body: string): string {
  const entries = readHandoff(previous);
  const next = { step, body: body.trim() };
  const index = entries.findIndex((item) => item.step === step);
  if (index >= 0) {
    entries[index] = next;
  } else {
    entries.push(next);
  }
  return JSON.stringify(entries);
}

export function withHandoff(
  sections: { heading: string; body: string }[],
  handoff: string | null,
): { heading: string; body: string }[] {
  const text = handoffText(handoff);
  return text.trim() ? [...sections, { heading: 'What previous steps did', body: text }] : sections;
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

/** The `Subtasks` section: per task its title, what it changed and its files. Left out when the run has no tasks. */
export function withSubtasks(
  sections: { heading: string; body: string }[],
  tasks: Subtask[] | null,
  lead?: string,
): { heading: string; body: string }[] {
  if (!tasks?.length) {
    return sections;
  }
  const entries = tasks.map((task) =>
    [
      `- ${task.title}`,
      `  changed: ${[task.description, task.note].filter((part) => part?.trim()).join(' ')}`,
      `  files: ${task.files.join(', ')}`,
    ].join('\n'),
  );
  return [...sections, { heading: 'Subtasks', body: [lead, ...entries].filter(Boolean).join('\n') }];
}

/** The contract with a decision added under `decisions:`. The heading is created when the contract has none. */
export function withDecision(contract: string, taskId: string, answer: string): string {
  const [first = '', ...rest] = answer.trim().split('\n');
  const entry = [`- subtask ${taskId}: ${first}`, ...rest.map((line) => `  ${line}`)].join('\n');
  const body = contract.trimEnd();
  return `${body}${/^decisions:\s*$/m.test(body) ? '\n' : `${body ? '\n\n' : ''}decisions:\n`}${entry}\n`;
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
  return (
    readHandoff(text)
      .find((item) => item.step === step)
      ?.body.trim() ?? ''
  );
}

/** The return notes: the stored ones, else the latest issues, else the ones the latest reviews and pipeline result call for. */
export function composedReturn(documents: { kind: string; body: string }[]): string | null {
  const latest = (kind: string): string | null =>
    [...documents].reverse().find((item) => item.kind === kind)?.body ?? null;
  const stored = latest(ARTIFACTS.return.kind);
  if (stored?.trim()) {
    return stored;
  }
  const issues = ARTIFACTS.issues
    .parse(latest(ARTIFACTS.issues.kind) ?? '[]')
    .filter((issue) => issue.source !== CI_INFRA_SOURCE);
  if (issues.length > 0) {
    return returnNotes(issues).body;
  }
  const parts: { source: string; body: string }[] = [];
  for (const source of CODE_REVIEWERS) {
    const body = latest(REVIEWS.of(source));
    if (body && storedReview(source, documents)?.decision === 'return') {
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
