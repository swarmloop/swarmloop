import type { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import { requirementsView, runTitle } from '../../contract/requirements-view';

type TitledRun = Pick<RunEntity, 'id'> & Partial<Pick<RunEntity, 'title'>>;

/** The ids of the runs without a stored title: the only ones whose requirements a title is taken from. */
export function untitledRunIds(runs: TitledRun[]): number[] {
  return runs.filter((run) => !run.title?.trim()).map((run) => run.id);
}

/**
 * The latest requirements body, by run id, in one batched read. Only the runs without a stored title are read:
 * the others never use the body, and the list is built on every live update.
 */
export async function requirementBodies(
  documents: Pick<DocumentRepository, 'latestDocuments'>,
  runs: TitledRun[],
): Promise<Map<number, string>> {
  const untitled = untitledRunIds(runs);
  const found = untitled.length > 0 ? await documents.latestDocuments(untitled, ['requirements']) : [];
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
