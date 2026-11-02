import { DocumentEntity } from '../../history/entities';
import { composedReturn } from '../../steps/shared/handoff';

export function belongsToVisit(document: DocumentEntity, statId: number, kinds: string[], latestVisit: boolean): boolean {
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
    found ? documentView(found) : { kind: 'return', attempt: last.attempt, body, createdAt: new Date().toISOString() },
    ...last.documents.filter((item) => item.kind !== 'return'),
  ];
  return visits;
}

export function documentView(document: DocumentEntity): { kind: string; attempt: number; body: string; createdAt: string } {
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

function keepFile(files: Map<string, { name: string; path: string; body: string | null }>, row: { name: string; path: string; body: string | null }): void {
  const key = `${row.name}\0${row.path}`;
  const previous = files.get(key);
  if (!previous || row.body !== null) {
    files.set(key, row);
  }
}

function fileRow(name: string, path: string, encoding: string | undefined, body: string | null | undefined): { name: string; path: string; body: string | null } {
  return { name, path, body: encoding === 'base64' ? null : (body ?? null) };
}
