import type { OutageEnd, OutageRule } from '../runtime-outage';

const NO_TEXT = 'API error';

function apiError({ event }: OutageEnd): string | null {
  if (event?.type !== 'result' || event.is_error !== true || event.terminal_reason !== 'api_error') {
    return null;
  }
  return typeof event.result === 'string' && event.result.trim() !== '' ? event.result : NO_TEXT;
}

/** What Claude Code ends with when its API host did not answer after its own retries: a result event that is an `api_error`. */
export const CLAUDE_OUTAGES: readonly OutageRule[] = [apiError];
