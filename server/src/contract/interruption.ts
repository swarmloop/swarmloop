/** Why and how a step cut by a server restart goes on. Written once, with the decision to relaunch or not. */
export interface InterruptionNote {
  /** When the attempt was cut, as an ISO time. */
  at: string;
  relaunched: boolean;
  /** Why it was not started again. */
  cause?: 'limit' | 'stop';
  /** The launch limit that was reached, for cause `limit`. */
  limit?: number;
}

/** The note a stored body holds. Null when the body is damaged. */
export function readInterruption(body: string): InterruptionNote | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const { at, relaunched, cause, limit } = parsed as Record<string, unknown>;
  if (typeof at !== 'string' || typeof relaunched !== 'boolean') return null;
  if (cause !== undefined && cause !== 'limit' && cause !== 'stop') return null;
  return {
    at,
    relaunched,
    ...(cause ? { cause } : {}),
    ...(typeof limit === 'number' ? { limit } : {}),
  };
}

/** The sentence a person reads. `time` turns the stored time into the reader's local time. */
export function interruptionSentence(note: InterruptionNote, time: (iso: string) => string): string {
  const head = `Interrupted at ${time(note.at)} by a server restart.`;
  if (note.relaunched) return `${head} The server starts this step again by itself. Nothing to do.`;
  const why = note.cause === 'limit' ? `the launch limit of ${note.limit} was reached` : 'a stop was pending';
  return `${head} Not started again: ${why}. Resume, Replay or Skip.`;
}
