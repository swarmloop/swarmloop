import type { LimitRule } from '../runtime-limit';
import { resetsAt, resetsIn } from '../runtime-limit';

const APOSTROPHE = `['’]`;

/**
 * What the Codex CLI prints when the ChatGPT subscription or the API key is out of usage or rate. The usage-limit
 * wording is read from the strings of the `codex` 0.167.0 binary: `You've hit your usage limit.` or `… for <model>.`,
 * then a plan hint, then `try again at <time>`. The rate and quota texts are the OpenAI API's error messages.
 */
export const CODEX_LIMITS: readonly LimitRule[] = [
  {
    // You've hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 9:50 PM.
    pattern: new RegExp(`^You${APOSTROPHE}ve hit your usage limit\\b.*?\\btry again at (.+?)\\.?$`, 'i'),
    read: (match, now) => ({ window: 'usage', resetsAt: resetsAt(match[1], 'UTC', now) }),
  },
  {
    // You've hit your usage limit. Try again in 3 days 5 hours 2 minutes.
    pattern: new RegExp(`^You${APOSTROPHE}ve hit your usage limit\\b.*?\\btry again in (.+?)\\.?$`, 'i'),
    read: (match, now) => ({ window: 'usage', resetsAt: resetsIn(match[1], now) }),
  },
  {
    pattern: new RegExp(`^You${APOSTROPHE}ve hit your usage limit\\b`, 'i'),
    read: () => ({ window: 'usage' }),
  },
  {
    // Rate limit reached for gpt-6.1 in organization org-x on tokens per min. Please try again in 1.2s.
    pattern: /^Rate limit reached\b.*?\btry again in (.+?)\.?$/i,
    read: (match, now) => ({ window: 'rate', resetsAt: resetsIn(match[1], now) }),
  },
  {
    pattern: /^Rate limit reached\b/i,
    read: () => ({ window: 'rate' }),
  },
  {
    // You exceeded your current quota, please check your plan and billing details.
    pattern: /^You exceeded your current quota\b/i,
    read: () => ({ window: 'quota' }),
  },
];
