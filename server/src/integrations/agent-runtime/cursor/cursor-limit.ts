import type { LimitRule } from '../runtime-limit';
import { resetsAt, resetsIn } from '../runtime-limit';

const APOSTROPHE = `['’]`;

/** What the Cursor agent prints when the plan's usage or the request rate is used up. */
export const CURSOR_LIMITS: readonly LimitRule[] = [
  {
    // You've hit your usage limit. Your limit resets on Nov 14, 9am.
    pattern: new RegExp(
      `^You${APOSTROPHE}ve hit your (?:usage|free requests?) limit\\b.*?\\bresets (?:on |at )?(.+?)\\.?$`,
      'i',
    ),
    read: (match, now) => ({ window: 'usage', resetsAt: resetsAt(match[1], 'UTC', now) }),
  },
  {
    pattern: new RegExp(`^You${APOSTROPHE}ve hit your (?:usage|free requests?) limit\\b`, 'i'),
    read: () => ({ window: 'usage' }),
  },
  {
    // Rate limit exceeded. Try again in 30 seconds.
    pattern: /^Rate limit (?:exceeded|reached)\b.*?\btry again in (.+?)\.?$/i,
    read: (match, now) => ({ window: 'rate', resetsAt: resetsIn(match[1], now) }),
  },
  {
    pattern: /^Rate limit (?:exceeded|reached)\b/i,
    read: () => ({ window: 'rate' }),
  },
  {
    // ConnectError: [resource_exhausted] Error
    pattern: /^(?:\w+: )?(?:ConnectError: )?\[resource_exhausted\]/i,
    read: () => ({ window: 'quota' }),
  },
];
