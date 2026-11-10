import { localTime } from './format';

const NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' };

/** What the run page knows of a provider limit. Times are UTC, ISO 8601. */
interface LimitNote {
  runtime: string;
  resetsAt?: string;
  /** The agent that took over, `runtime:model`. */
  continuedWith?: string;
  /** When a waiting run goes on by itself. */
  resumesAt?: string;
}

/** `Claude hit its usage limit (resets 22:50). Continued with codex:gpt-6.1-sol.`, in the viewer's time. */
export function limitSentence(note: LimitNote): string {
  const reset = note.resetsAt ? ` (resets ${localTime(note.resetsAt)})` : '';
  const then = note.continuedWith
    ? ` Continued with ${note.continuedWith}.`
    : note.resumesAt
      ? ` The run goes on at ${localTime(note.resumesAt)}.`
      : '';
  return `${NAMES[note.runtime] ?? note.runtime} hit its usage limit${reset}.${then}`;
}
