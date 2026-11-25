import type { OutageEnd, OutageRule } from '../runtime-outage';

function unavailable({ texts }: OutageEnd): string | null {
  return texts.find((text) => text.startsWith('ConnectError: [unavailable]')) ?? null;
}

/** What the Cursor agent prints when its API host is unavailable: a `ConnectError: [unavailable]` text, in its error result or in stderr. */
export const CURSOR_OUTAGES: readonly OutageRule[] = [unavailable];
