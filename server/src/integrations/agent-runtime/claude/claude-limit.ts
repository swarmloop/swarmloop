import type { LimitRule } from '../runtime-limit';
import { resetsAt } from '../runtime-limit';

const APOSTROPHE = `['’]`;
const SEPARATOR = '\\s*[·∙•-]\\s*';
/** `resets 9:50pm (UTC)`: the time, then the zone Claude Code names in brackets. */
const RESETS = `(?:${SEPARATOR}resets\\s+(.+?)(?:\\s*\\(([^)]+)\\))?)?\\.?$`;

/** What Claude Code prints when the subscription's usage window is used up. */
export const CLAUDE_LIMITS: readonly LimitRule[] = [
  {
    // You've hit your 5-hour limit · resets 9:50pm (UTC)
    pattern: new RegExp(`^You${APOSTROPHE}ve hit your (?:(.+?) )?limit${RESETS}`, 'i'),
    read: (match, now) => ({ window: match[1], resetsAt: resetsAt(match[2], match[3], now) }),
  },
  {
    // 5-hour limit reached ∙ resets 3pm
    pattern: new RegExp(`^(.+?) limit reached${RESETS}`, 'i'),
    read: (match, now) => ({ window: match[1], resetsAt: resetsAt(match[2], match[3], now) }),
  },
];
