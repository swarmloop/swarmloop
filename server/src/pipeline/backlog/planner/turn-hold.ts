import type { BacklogTurnRecord } from '../../../history/backlog-writers';

/** The one rule recover and the timer (through executeWaiting) read: a turn waits for its next try (waiting, or applied with a next try). */
export function waitsForTry(turn: BacklogTurnRecord): boolean {
  return turn.status === 'waiting' || (turn.status === 'applied' && turn.nextTryAt !== null);
}

/** The one rule the events pass reads: a backlog is held only while its last turn failed or waits. */
export function holdsBacklog(turns: BacklogTurnRecord[]): boolean {
  const last = turns.at(-1);
  return last !== undefined && (last.status === 'failed' || waitsForTry(last));
}

/** The one rule Resume reads: the last turn when it failed, else the latest applied turn whose sending failed. */
export function resumeTarget(turns: BacklogTurnRecord[]): BacklogTurnRecord | null {
  const last = turns.at(-1);
  if (last?.status === 'failed') return last;
  const sending = turns.filter((turn) => turn.status === 'applied' && turn.reason !== '' && turn.nextTryAt === null);
  return sending.at(-1) ?? null;
}

/** The one rule a new turn reads: the keys of the failed turns, whose items a new turn takes over. */
export function failedKeys(turns: BacklogTurnRecord[]): string[] {
  return turns.filter((turn) => turn.status === 'failed').map((turn) => turn.turnKey);
}
