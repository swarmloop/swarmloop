import type { LimitHit } from '../runtime-limit';

/** The name of each window Claude Code reports a rate limit for, as the limit texts of this adapter name it. */
const WINDOWS: Readonly<Record<string, string>> = { five_hour: '5-hour', seven_day: 'weekly' };

interface RateLimitInfo {
  isUsingOverage?: unknown;
  rateLimitType?: unknown;
  resetsAt?: unknown;
}

/**
 * The limit a `rate_limit_event` line of Claude Code's stream-json output says: the launch runs on paid use past the plan
 * (`isUsingOverage` true), in the window of `rateLimitType`, until `resetsAt` (unix seconds). Any other line gives null.
 */
export function claudePaidUse(line: string): LimitHit | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) {
    return null;
  }
  let event: { type?: unknown; rate_limit_info?: RateLimitInfo | null };
  try {
    event = JSON.parse(trimmed) as typeof event;
  } catch {
    return null;
  }
  const info = event.type === 'rate_limit_event' ? event.rate_limit_info : null;
  if (!info || info.isUsingOverage !== true) {
    return null;
  }
  const type = info.rateLimitType;
  const window = typeof type === 'string' && Object.hasOwn(WINDOWS, type) ? WINDOWS[type] : undefined;
  const resetsAt = typeof info.resetsAt === 'number' ? new Date(info.resetsAt * 1000) : null;
  return {
    ...(window ? { window } : {}),
    ...(resetsAt && !Number.isNaN(resetsAt.getTime()) ? { resetsAt: resetsAt.toISOString() } : {}),
  };
}
