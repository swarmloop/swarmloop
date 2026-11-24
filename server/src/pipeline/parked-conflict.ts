import { parseJournal, REBASE_JOURNAL } from '../git/rebase';
import { REBASE_CONFLICT } from '../git/rebase/rebase';
import type { DocumentRepository } from '../history/document.repository';
import type { DocumentEntity, RunEntity } from '../history/entities';
import { latest } from '../history/latest-document';

const PARKED_MARKERS = ['pending', 'pending-implement'];

interface ParkedFacts {
  /** The body of the run's `rebase_conflict` marker. */
  marker: string | null;
  /** The body of the run's rebase journal. */
  journal: string | null;
  generation: number;
}

/** True when the marker sends the conflict to implement and the journal holds a repo parked at `conflict` of this generation. */
export function parkedConflict({ marker, journal, generation }: ParkedFacts): boolean {
  const first = marker?.split('\n')[0]?.trim() ?? '';
  if (!PARKED_MARKERS.includes(first)) return false;
  return Object.values(parseJournal(journal)).some(
    (entry) => entry.checkpoint === 'conflict' && entry.generation === generation,
  );
}

/** The fact from a loaded list of the run's documents, in the order they were written. */
export function parkedConflictIn(
  documents: Pick<DocumentEntity, 'kind' | 'body'>[],
  run: Pick<RunEntity, 'generation'>,
): boolean {
  return parkedConflict({
    marker: latest(documents, REBASE_CONFLICT),
    journal: latest(documents, REBASE_JOURNAL),
    generation: run.generation,
  });
}

/** The fact from the stored documents of the run. */
export async function readParkedConflict(
  documents: DocumentRepository,
  run: Pick<RunEntity, 'key' | 'generation'>,
): Promise<boolean> {
  return parkedConflict({
    marker: await documents.latestBody(run.key, REBASE_CONFLICT),
    journal: await documents.latestBody(run.key, REBASE_JOURNAL),
    generation: run.generation,
  });
}
