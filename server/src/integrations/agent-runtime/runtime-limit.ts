/** What a provider's limit text says: the window it names and when it ends (UTC, ISO 8601). Both are optional. */
export interface LimitHit {
  window?: string;
  resetsAt?: string;
}

export interface LimitInput {
  /** The last line of the stream: the `result` event, or whatever the CLI printed last. */
  finalLine: string;
  stderr: string;
  now: number;
}

/** One sample of a provider's text. `read` turns a match into the hit; the text has to start with the pattern. */
export interface LimitRule {
  pattern: RegExp;
  read(match: RegExpExecArray, now: number): LimitHit;
}

const LIMIT_TEXT_CHARS = 400;
const MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function stringsOf(value: unknown): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return [record.result, record.message, record.error].flatMap(stringsOf);
  }
  return [];
}

/** The texts one output line carries: the strings of a stream event, or the line itself. */
function textsOf(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) {
    return [trimmed];
  }
  try {
    const event: unknown = JSON.parse(trimmed);
    // A result the CLI reports as a success is the model's own answer, so text in it is never a provider limit.
    const success = typeof event === 'object' && event !== null && (event as { is_error?: unknown }).is_error === false;
    return success ? [] : stringsOf(event);
  } catch {
    return [trimmed];
  }
}

/**
 * The first rule that matches the start of the final line or of a line of stderr. A limit message is short and begins
 * the text, so an answer that only quotes one is never taken for a limit.
 */
export function classifyLimit(rules: readonly LimitRule[], input: LimitInput): LimitHit | null {
  const texts = [...textsOf(input.finalLine), ...input.stderr.split('\n').flatMap(textsOf)];
  for (const text of texts) {
    const line = text.trim();
    if (line === '' || line.length > LIMIT_TEXT_CHARS) {
      continue;
    }
    for (const rule of rules) {
      const match = rule.pattern.exec(line);
      if (match) {
        return rule.read(match, input.now);
      }
    }
  }
  return null;
}

/** The next time the clock shows `text` (`9:50pm`, `9 PM`, `21:50`) after `now`, in UTC. */
function nextClockTime(text: string, now: number): number | null {
  const match = /^(\d{1,2})(?::(\d{2}))?\s*([ap]m)?$/i.exec(text.trim());
  if (!match) {
    return null;
  }
  const meridiem = match[3]?.toLowerCase();
  let hours = Number(match[1]);
  if (meridiem && (hours < 1 || hours > 12)) {
    return null;
  }
  if (meridiem === 'pm' && hours < 12) {
    hours += 12;
  } else if (meridiem === 'am' && hours === 12) {
    hours = 0;
  }
  const minutes = Number(match[2] ?? 0);
  if (hours > 23 || minutes > 59) {
    return null;
  }
  const day = new Date(now);
  const at = Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hours, minutes);
  return at > now ? at : at + MS.d;
}

/** `Nov 14, 9am` or `Nov 14th, 2026 9:50 PM`: a month and a day, then a clock time. The year is the next one that fits. */
function dateAndClock(text: string, now: number): number | null {
  const match = /^([a-z]{3})[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s*(?:(\d{4}),?\s+)?(?:at\s+)?(.+)$/i.exec(
    text.trim(),
  );
  const month = MONTHS.indexOf(match?.[1]?.toLowerCase() ?? '');
  if (!match || month < 0) {
    return null;
  }
  const clock = nextClockTime(match[4] ?? '', now - MS.d);
  if (clock === null) {
    return null;
  }
  const time = new Date(clock);
  const year = match[3] ? Number(match[3]) : new Date(now).getUTCFullYear();
  const at = Date.UTC(year, month, Number(match[2]), time.getUTCHours(), time.getUTCMinutes());
  return !match[3] && at <= now
    ? Date.UTC(year + 1, month, Number(match[2]), time.getUTCHours(), time.getUTCMinutes())
    : at;
}

/** A length of time as providers write it: `3 days 5 hours 2 minutes`, `1h 30m`, `45s`. */
function lengthOfTime(text: string): number | null {
  let total = 0;
  let found = false;
  for (const part of text.matchAll(/(\d+(?:\.\d+)?)\s*(d|h|min|m|s)[a-z]*/gi)) {
    const unit = part[2]?.toLowerCase() === 'min' ? 'm' : (part[2]?.toLowerCase() as keyof typeof MS);
    total += Number(part[1]) * MS[unit];
    found = true;
  }
  return found ? total : null;
}

/** The end of a limit, in UTC, from the time text a provider wrote. A zone other than UTC, or text that is no time, gives none. */
export function resetsAt(text: string | undefined, zone: string | undefined, now: number): string | undefined {
  if (!text || (zone !== undefined && !/^(etc\/)?(utc|gmt|z)$/i.test(zone.trim()))) {
    return undefined;
  }
  const at = nextClockTime(text, now) ?? dateAndClock(text, now);
  return at === null ? undefined : new Date(at).toISOString();
}

/** The end of a limit that a provider gives as a length of time from now. */
export function resetsIn(text: string | undefined, now: number): string | undefined {
  const length = text ? lengthOfTime(text) : null;
  return length === null ? undefined : new Date(now + length).toISOString();
}
