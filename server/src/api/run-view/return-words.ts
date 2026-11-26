import type { CheckCommandView } from '../../contract/api';
import { readLoopDetail, reviewersOf } from '../../history/loop-detail';
import type { LoopEventEntity } from '../../history/entities';

const SENDERS: Record<string, string> = {
  review: 'Code review',
  checks: 'Checks',
  pipeline: 'CI',
};

/** The failed commands of a checks return by their short names from the run's check rows, or `checks` for a row with none. */
function commandNames(loop: LoopEventEntity, rows: CheckCommandView[]): string[] {
  return (readLoopDetail(loop.detail).commands ?? []).map(
    (command) => rows.find((row) => row.command === command)?.name || 'checks',
  );
}

function namesOf(counter: string, loop: LoopEventEntity, rows: CheckCommandView[]): string[] {
  if (counter === 'review') return reviewersOf(loop.reason);
  if (counter === 'checks') return commandNames(loop, rows);
  return readLoopDetail(loop.detail).jobs ?? [];
}

/**
 * A return in plain words for a person, such as `Code review sent it back: requirements, quality`. Reviewers, check
 * commands and CI jobs are named, never shown as ids or command lines. Undefined for a counter that is no return.
 */
export function returnWords(counter: string, loop: LoopEventEntity, rows: CheckCommandView[]): string | undefined {
  const sender = SENDERS[counter];
  if (!sender) return undefined;
  const names = [...new Set(namesOf(counter, loop, rows))];
  return names.length > 0 ? `${sender} sent it back: ${names.join(', ')}` : `${sender} sent it back`;
}
