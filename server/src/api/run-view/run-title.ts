import type { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import { requirementsView, runTitle } from '../../contract/requirements-view';

/** The latest requirements body of each of the runs, by run id, in one batched read. */
export async function requirementBodies(
  documents: Pick<DocumentRepository, 'latestDocuments'>,
  runIds: number[],
): Promise<Map<number, string>> {
  const found = await documents.latestDocuments(runIds, ['requirements']);
  return new Map(found.map((document) => [document.runId, document.body]));
}

/** The title a person sees: the one research stored, else the title of the requirements, else the prompt, else the key. */
export function viewTitle(
  run: Pick<RunEntity, 'key' | 'prompt'> & Partial<Pick<RunEntity, 'title'>>,
  requirements: string | null,
): string {
  const stored = run.title?.trim();
  if (stored) {
    return stored;
  }
  const fromRequirements = runTitle(requirements === null ? '' : (requirementsView(requirements)?.title ?? ''));
  return fromRequirements || runTitle(run.prompt ?? '') || run.key;
}
