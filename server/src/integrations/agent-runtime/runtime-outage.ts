import { redact } from '../../config/redact';
import { stringsOf, type LimitInput } from './runtime-limit';

/** The model host a launch could not reach, and what the CLI said about it. */
export interface ModelHostOutage {
  host: string;
  detail: string;
}

/** What a rule sees of the end of a launch: the final line as an event (null when it is no JSON object) and the texts the end carries. */
export interface OutageEnd {
  event: Record<string, unknown> | null;
  texts: string[];
}

/** One sample of a CLI's outage. It returns the CLI's error text, or null when the end is not that outage. */
export type OutageRule = (end: OutageEnd) => string | null;

function eventOf(line: string): Record<string, unknown> | null {
  try {
    const event: unknown = JSON.parse(line);
    return typeof event === 'object' && event !== null && !Array.isArray(event)
      ? (event as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/**
 * The outage the end of a launch reports: the first rule that reads the final line or stderr gives the detail, the first line of
 * the CLI's error text. A result the CLI reports as a success is the model's own answer, so it is never an outage.
 */
export function classifyOutage(rules: readonly OutageRule[], host: string, input: LimitInput): ModelHostOutage | null {
  const final = input.finalLine.trim();
  const event = final.startsWith('{') ? eventOf(final) : null;
  if (event?.is_error === false) {
    return null;
  }
  const texts = [event ? stringsOf(event) : [final], ...input.stderr.split('\n').map((line) => [line.trim()])]
    .flat()
    .filter((text) => text !== '');
  for (const rule of rules) {
    const text = rule({ event, texts });
    if (text !== null) {
      return { host, detail: redact(text.trim().split('\n')[0] ?? '') };
    }
  }
  return null;
}
