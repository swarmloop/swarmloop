import type { TranscriptItem } from './transcript-model';

/** More consecutive actions than this fold into one row. */
const ACTION_RUN = 5;

/** A run of consecutive actions folded into one row. */
interface ActionRun {
  key: string;
  items: TranscriptItem[];
}

/** A card of the feed, or a folded run of action cards. */
type FeedRow = { item: TranscriptItem } | { run: ActionRun };

/** A command, a call or a run of reads that went well. */
function isAction(item: TranscriptItem): boolean {
  return (
    item.problem === null &&
    (item.reads !== undefined || item.event.kind === 'command.started' || item.event.kind === 'http.call')
  );
}

/** The cards of one attempt, where more than five actions in a row fold into one row. A problem is never folded. */
export function foldActions(items: TranscriptItem[]): FeedRow[] {
  const rows: FeedRow[] = [];
  let pending: TranscriptItem[] = [];
  const flush = (): void => {
    if (pending.length > ACTION_RUN) {
      rows.push({ run: { key: pending[0].event.eventId, items: pending } });
    } else {
      pending.forEach((item) => rows.push({ item }));
    }
    pending = [];
  };
  for (const item of items) {
    if (isAction(item)) {
      pending.push(item);
    } else {
      flush();
      rows.push({ item });
    }
  }
  flush();
  return rows;
}
