import type { DocumentEntity } from '../../history/entities';
import type { FlowView, TaskLayer } from '../../contract/api';
import { parseSubtasks, splitLine, type Subtask } from '../../contract/subtask';
import { STEPS, type StepName } from '../../contract/steps';
import { readPlan } from '../../steps/plan/plan-record';
import { composedReturn } from '../../steps/shared/handoff';
import { latest } from './status';

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

/** A visit stored before attempts has no file, so the `log` document it kept is its only log. */
export function legacyLogs(
  documents: DocumentEntity[],
  stat: { id: number; attemptId: string | null },
): DocumentEntity[] {
  return stat.attemptId
    ? []
    : documents.filter((document) => document.stepStatId === stat.id && document.kind === 'log');
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
  return { kind: document.kind, attempt: document.attempt, body: document.body, createdAt: document.createdAt };
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

/** The tasks plan-improve approved, by layer: a task is one layer below its deepest dependency. Empty for a run that does not split. */
export function taskLayers(documents: DocumentEntity[], children: TaskRuns = new Map()): TaskLayer[] {
  if (readPlan(latest(documents, 'requirements'))?.decision !== 'approve') {
    return [];
  }
  const tasks = parseSubtasks(latest(documents, 'subtasks'));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  // The parser refuses a cycle, so the walk ends; `seen` only keeps a damaged document from looping.
  const depth = (task: Subtask, seen: string[] = []): number => {
    const known = task.depends.filter((id) => byId.has(id) && !seen.includes(id));
    return known.length === 0 ? 0 : 1 + Math.max(...known.map((id) => depth(byId.get(id)!, [...seen, task.id])));
  };
  const layers = new Map<number, TaskLayer['tasks']>();
  for (const task of tasks) {
    const layer = depth(task);
    layers.set(layer, [
      ...(layers.get(layer) ?? []),
      {
        id: task.id,
        title: task.title,
        files: task.files,
        proof: task.proof,
        depends: task.depends,
        status: task.status,
        note: task.note,
        ...(children.has(task.id) ? { run: children.get(task.id) } : {}),
      },
    ]);
  }
  return [...layers.entries()].sort(([a], [b]) => a - b).map(([layer, group]) => ({ layer, tasks: group }));
}

/** The one-line status of a split run's tasks, once the run is at implement or past it. */
export function taskLine(documents: DocumentEntity[], currentStep: string): string | null {
  const tasks = parseSubtasks(latest(documents, 'subtasks'));
  const reached = STEPS.indexOf(currentStep as StepName) >= STEPS.indexOf('implement');
  return tasks.length > 0 && reached && taskLayers(documents).length > 0 ? splitLine(tasks) : null;
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
export type TaskRuns = Map<string, NonNullable<TaskLayer['tasks'][number]['run']>>;

/** The `tasks`, `taskLine`, `mergeQueue` and `decisions` of a flow view. Empty for a run that does not split. */
export function taskView(
  documents: DocumentEntity[],
  currentStep: string,
  children: TaskRuns = new Map(),
): Pick<FlowView, 'tasks' | 'taskLine' | 'mergeQueue' | 'decisions'> {
  const tasks = taskLayers(documents, children);
  const line = taskLine(documents, currentStep);
  const queue = parseSubtasks(latest(documents, 'subtasks'))
    .filter((task) => task.status === 'green')
    .map(({ id, title }) => ({ id, title }));
  const decisions = decisionsOf(latest(documents, 'contract'));
  return {
    ...(tasks.length > 0 ? { tasks } : {}),
    ...(line ? { taskLine: line } : {}),
    ...(tasks.length > 0 && queue.length > 0 ? { mergeQueue: queue } : {}),
    ...(tasks.length > 0 && decisions ? { decisions } : {}),
  };
}
