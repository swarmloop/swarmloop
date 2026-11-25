import type { OutageEnd, OutageRule } from '../runtime-outage';

function brokenStream({ event, texts }: OutageEnd): string | null {
  if (event?.type !== 'turn.failed' && event?.type !== 'error') {
    return null;
  }
  return (
    texts.find(
      (text) =>
        text.startsWith('stream disconnected before completion') || text.includes('error sending request for url'),
    ) ?? null
  );
}

/**
 * What the Codex CLI ends with when its API host did not answer after its own retries: a final `turn.failed` or `error`
 * event whose message says the stream broke or the request could not be sent.
 */
export const CODEX_OUTAGES: readonly OutageRule[] = [brokenStream];
