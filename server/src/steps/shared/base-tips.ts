import { parseJournal, REBASE_JOURNAL } from '../../git/rebase';
import { atOrPast } from '../../git/rebase/journal';
import type { Journal, KnownTips, RebaseJournal } from '../../git/rebase';
import type { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import type { RunRepository } from '../../history/run.repository';

/**
 * The record of the base tip each repository of a run stands on, and of the commits it is known to have stood on:
 * what `ownChangeBase` measures the run's own change from. A run made before the tip was stored has none, and takes
 * what the journals of its own moves and of its parent's moves still hold.
 */
export class BaseTips {
  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
  ) {}

  /** The commits each repository of the run is known to have stood on, without duplicates and in no order. */
  async known(run: RunEntity, repos: string[]): Promise<KnownTips> {
    // A recorded tip is the newest tip of a run: its own journal history only serves a run made before it was recorded.
    const own = run.baseTips ? [] : await this.history(run);
    const parent = run.parentRunId === null ? null : await this.runs.findById(run.parentRunId);
    const parents = parent ? await this.history(parent) : [];
    const known: KnownTips = {};
    for (const repo of repos) {
      const tips = [
        run.baseTips?.[repo],
        ...own.map((journal) => (journal[repo]?.checkpoint === 'completed' ? journal[repo].baseSha : undefined)),
        ...parents.flatMap((journal) => [journal[repo]?.oldHead, journal[repo]?.baseSha]),
      ];
      known[repo] = [...new Set(tips.filter((tip): tip is string => !!tip))];
    }
    return known;
  }

  /** The tip each repository that a move just applied stands on: written with the move, before it completes. */
  async recordMoved(run: RunEntity, journal: RebaseJournal): Promise<void> {
    const moved: Record<string, string> = {};
    for (const [repo, entry] of Object.entries(await journal.read())) {
      if (atOrPast(entry, 'applied') && entry.checkpoint !== 'completed') {
        moved[repo] = entry.baseSha;
      }
    }
    await this.record(run, moved);
  }

  record(run: RunEntity, tips: Record<string, string>): Promise<void> {
    return this.runs.recordBaseTips(run.key, tips);
  }

  /** Every version the run's rebase journal had. */
  private async history(run: RunEntity): Promise<Journal[]> {
    return (await this.documents.bodiesOfKind(run.id, REBASE_JOURNAL)).map(parseJournal);
  }
}
