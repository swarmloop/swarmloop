import type { DocumentEntity } from '../../history/entities';
import type { FlowView, TaskEntry } from '../../contract/api';
import { readInterruption, type InterruptionNote } from '../../contract/interruption';
import { parseSubtasks, shownTaskState, splitLine, unmetDepends } from '../../contract/subtask';
import { STEPS, type StepName } from '../../contract/steps';
import { readPlan } from '../../steps/plan/plan-record';
import { composedReturn, handoffText } from '../../steps/shared/handoff';
import { latest } from './status';
import { isResultKind } from '../../agent-result/result-definition';
import { ARTIFACTS } from '../../steps/contract/artifacts';

/** The documents a person reads: the stored result objects, the answer errors, the plan chat and the interruption notes are server records, left out. */
export function withoutServerRecords<T extends { kind: string }>(documents: T[]): T[] {
  return documents.filter(
    (document) =>
      !isResultKind(document.kind) &&
      document.kind !== ARTIFACTS.answerErrors.kind &&
      document.kind !== ARTIFACTS.planChat.kind &&
      document.kind !== 'interruption',
  );
}

/** The interruption note stored with the visit `statId`, or null when that visit has none. */
export function interruptionOf(documents: DocumentEntity[], statId: number): InterruptionNote | null {
  const found = documents
    .filter((document) => document.kind === 'interruption' && document.stepStatId === statId)
    .at(-1);
  return found ? readInterruption(found.body) : null;
}

export function belongsToVisit(
  document: DocumentEntity,
  statId: number,
  kinds: string[],
  latestVisit: boolean,
): boolean {
  if (!kinds.includes(document.kind)) {
    return false;
  }
  if (document.stepStatId === statId) {
    return true;
  }
  return latestVisit && document.stepStatId === 0 && document.kind !== 'error' && document.kind !== 'log';
}

export function withReturnNotes<T extends { attempt: number; documents: ReturnType<typeof documentView>[] }>(
  name: string,
  visits: T[],
  documents: DocumentEntity[],
  now: number,
): T[] {
  if (name !== 'implement' && name !== 'implement-improve') {
    return visits;
  }
  const last = visits.at(-1);
  const body = composedReturn(documents);
  if (!last || !body) {
    return visits;
  }
  const found = [...documents].reverse().find((document) => document.kind === 'return');
  last.documents = [
    found
      ? documentView(found)
      : { kind: 'return', attempt: last.attempt, body, createdAt: new Date(now).toISOString() },
    ...last.documents.filter((item) => item.kind !== 'return'),
  ];
  return visits;
}

export function documentView(document: DocumentEntity): {
  kind: string;
  attempt: number;
  body: string;
  createdAt: string;
} {
  const body = document.kind === ARTIFACTS.handoff.kind ? handoffText(document.body) : document.body;
  return { kind: document.kind, attempt: document.attempt, body, createdAt: document.createdAt };
}

export function filesOf(documents: DocumentEntity[]): { name: string; path: string; body: string | null }[] {
  const files = new Map<string, { name: string; path: string; body: string | null }>();
  for (const document of documents.filter((item) => item.kind === 'requirements')) {
    try {
      const parsed = JSON.parse(document.body) as {
        files?: { name?: string; path?: string; body?: string | null; encoding?: string }[];
        pages?: { title?: string; path?: string; body?: string; encoding?: string }[];
      };
      for (const file of parsed.files ?? []) {
        keepFile(files, fileRow(file.name ?? file.path ?? 'file', file.path ?? '', file.encoding, file.body));
      }
      for (const page of parsed.pages ?? []) {
        keepFile(files, fileRow(page.title ?? page.path ?? 'page', page.path ?? '', page.encoding, page.body));
      }
    } catch {
      continue;
    }
  }
  return [...files.values()];
}

function keepFile(
  files: Map<string, { name: string; path: string; body: string | null }>,
  row: { name: string; path: string; body: string | null },
): void {
  const key = `${row.name}\0${row.path}`;
  const previous = files.get(key);
  if (!previous || row.body !== null) {
    files.set(key, row);
  }
}

function fileRow(
  name: string,
  path: string,
  encoding: string | undefined,
  body: string | null | undefined,
): { name: string; path: string; body: string | null } {
  return { name, path, body: encoding === 'base64' ? null : (body ?? null) };
}

/** The tasks plan-improve approved, in plan order. Empty for a run that does not split. */
export function taskEntries(documents: DocumentEntity[], children: TaskRuns = new Map()): TaskEntry[] {
  if (readPlan(latest(documents, 'requirements'))?.decision !== 'approve') {
    return [];
  }
  const tasks = parseSubtasks(latest(documents, 'subtasks'));
  const titles = new Map(tasks.map((task) => [task.id, task.title]));
  return tasks.map((task, index) => {
    const status = shownTaskState(task, children.get(task.id));
    return {
      id: task.id,
      index,
      title: task.title,
      files: task.files,
      proof: task.proof,
      depends: task.depends,
      status,
      note: task.note,
      ...(status === 'waiting' || status === 'pending'
        ? { waitsFor: unmetDepends(task, tasks).map((id) => titles.get(id) ?? id) }
        : {}),
      ...(children.has(task.id) ? { run: children.get(task.id) } : {}),
    };
  });
}

/** The one-line status of a split run's tasks, once the run is at implement or past it. */
export function taskLine(documents: DocumentEntity[], currentStep: string): string | null {
  const tasks = parseSubtasks(latest(documents, 'subtasks'));
  const reached = STEPS.indexOf(currentStep as StepName) >= STEPS.indexOf('implement');
  return tasks.length > 0 && reached && taskEntries(documents).length > 0 ? splitLine(tasks) : null;
}

/** The `decisions:` block of the contract: its entries, without the heading. */
export function decisionsOf(contract: string | null): string | null {
  const lines = (contract ?? '').split('\n');
  const start = lines.findIndex((line) => /^decisions:\s*$/.test(line));
  if (start < 0) {
    return null;
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^[\w ]+:\s*$/.test(line));
  return (end < 0 ? rest : rest.slice(0, end)).join('\n').trim() || null;
}

/** The own run of each task, by task id. */
export type TaskRuns = Map<string, NonNullable<TaskEntry['run']>>;

/** The `tasks`, `taskLine`, `mergeQueue` and `decisions` of a flow view. Empty for a run that does not split. */
export function taskView(
  documents: DocumentEntity[],
  currentStep: string,
  children: TaskRuns = new Map(),
): Pick<FlowView, 'tasks' | 'taskLine' | 'mergeQueue' | 'decisions'> {
  const tasks = taskEntries(documents, children);
  const line = taskLine(documents, currentStep);
  const shown = new Map(tasks.map((task) => [task.id, task.status]));
  const queue = parseSubtasks(latest(documents, 'subtasks'))
    .filter((task) => shown.get(task.id) === 'green')
    .map(({ id, title }) => ({ id, title }));
  const decisions = decisionsOf(latest(documents, 'contract'));
  return {
    ...(tasks.length > 0 ? { tasks } : {}),
    ...(line ? { taskLine: line } : {}),
    ...(tasks.length > 0 && queue.length > 0 ? { mergeQueue: queue } : {}),
    ...(tasks.length > 0 && decisions ? { decisions } : {}),
  };
}
