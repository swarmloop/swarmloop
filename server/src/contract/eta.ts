import { NEEDS_PERSON, stateWord } from './run-state';
import type { RunState, StateReason } from './run-state';

/** A rough estimate of how long a run still needs: the time left and when it should be done (UTC, ISO 8601). */
export interface RunEta {
  leftMs: number;
  doneAt: string;
}

/** The least time an estimate shows. */
export const ETA_MIN_MS = 60_000;

/** A run that does not split, an epic parent, or a subtask: each keeps its own step numbers. */
export type RunKind = 'plain' | 'epic' | 'subtask';

/** `person`: waits for a person. `timed`: waits for a next try. `working`: moves by itself. `ended`: nothing is left. */
export type EtaPhase = 'person' | 'timed' | 'working' | 'ended';

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** When the next automatic try happens, or null when the reason has none. */
export function nextTryAt(reason: StateReason | null | undefined): string | null {
  return reason?.retryAt ?? reason?.limit?.resumesAt ?? null;
}

/** Which kind of time a run in this state is in; read from the state words and the needs-a-person list. */
export function etaPhase(state: RunState | 'skipped', reason: StateReason | null | undefined): EtaPhase {
  if (state === 'done' || state === 'merged' || state === 'closed' || state === 'skipped') {
    return 'ended';
  }
  const tone = stateWord(state, reason ?? null, {}, (iso) => iso).tone;
  if (tone !== 'working' || (reason && reason.code in NEEDS_PERSON)) {
    return 'person';
  }
  return nextTryAt(reason) === null ? 'working' : 'timed';
}

function roundedLeft(leftMs: number): string {
  const ms = Math.max(leftMs, ETA_MIN_MS);
  if (ms < HOUR_MS) {
    return `${Math.max(5, Math.round(ms / (5 * MINUTE_MS)) * 5)}m`;
  }
  const minutes = Math.round(ms / (15 * MINUTE_MS)) * 15;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** The words of an estimate and its tooltip; a null estimate is a run that waits for a person. */
export function etaWords(eta: RunEta | null, time: (iso: string) => string): { text: string; tip: string } {
  if (!eta) {
    return { text: 'waits for you', tip: '' };
  }
  return { text: `~${roundedLeft(eta.leftMs)} left`, tip: `done around ${time(eta.doneAt)} · rough estimate` };
}
