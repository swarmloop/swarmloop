import type { DocumentEntity } from './entities';

/** The body of the latest document of a kind among the documents of a run, in the order they were written. */
export function latest(documents: DocumentEntity[], kind: string): string | null {
  const found = [...documents].reverse().find((document) => document.kind === kind);
  return found?.body ?? null;
}
