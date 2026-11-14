import { logFinished } from './readable-log';
import { agentDecision } from './readable-log-agent';

/** The decision in the result block of a reviewer's log; null while the log holds none. */
export function reviewLogDecision(raw: string): 'ok' | 'return' | null {
  return agentDecision(raw);
}

export function reviewChipStatus(raw: string): 'done' | 'returned' | 'failed' | null {
  if (!logFinished(raw)) {
    return null;
  }
  const decision = reviewLogDecision(raw);
  if (decision === 'ok') {
    return 'done';
  }
  if (decision === 'return') {
    return 'returned';
  }
  return 'failed';
}
