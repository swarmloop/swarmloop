import { RebaseJournal, REBASE_JOURNAL } from '../../git/rebase';
import type { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';

/** The journal of a run, kept as its `rebase_journal` document. */
export function runJournal(documents: DocumentRepository, run: RunEntity): RebaseJournal {
  return new RebaseJournal(
    {
      read: () => documents.latestBody(run.key, REBASE_JOURNAL),
      write: (body) => documents.putDocument(run, REBASE_JOURNAL, body),
    },
    run.generation,
  );
}
