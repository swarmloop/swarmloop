import type { StepName } from '../../contract/steps';

interface Codec<T> {
  parse(body: string): T;
  format(value: T): string;
}

/** A kind of stored document: who writes it, who reads it, and how its body is read and written. */
export interface Artifact<T = string> extends Codec<T> {
  kind: string;
  writers: readonly StepName[];
  readers: readonly StepName[];
  /** Written by a person, a provider or the step kernel (handoff, error, log), not by the step's own result. */
  external?: boolean;
  /** One line of at most 160 characters that tells what a value holds. Never raw JSON. */
  summarize(value: T): string;
}

export interface ArtifactFamily {
  prefix: string;
  of(suffix: string): string;
  kinds: readonly string[];
  matches(kind: string): boolean;
}

const SUMMARY_CHARS = 160;

/** The first non-empty line, cut to one summary line. A JSON body is named by its keys or its length, never by its first bracket. */
export function firstLine(text: string): string {
  const line = text.split('\n').find((item) => item.trim() !== '') ?? '';
  const trimmed = line.trim();
  if (/^[[{]/.test(trimmed)) {
    try {
      const parsed: unknown = JSON.parse(text);
      return (
        Array.isArray(parsed) ? `${parsed.length} entries` : `fields: ${Object.keys(parsed as object).join(', ')}`
      ).slice(0, SUMMARY_CHARS);
    } catch {
      // Not JSON that parses: the line stays as it is.
    }
  }
  return trimmed.slice(0, SUMMARY_CHARS);
}

/** `<n> <noun>: <first>` for a list. */
export function listSummary(count: number, noun: string, first: string | undefined): string {
  return `${count} ${noun}${first ? `: ${first}` : ''}`.slice(0, SUMMARY_CHARS);
}

const textCodec: Codec<string> = {
  parse: (body) => body,
  format: (value) => value,
};

/** One entry per non-blank line, trimmed. The same split as `repoNames`. */
export const linesCodec: Codec<string[]> = {
  parse: (body) =>
    body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  format: (lines) => `${lines.join('\n')}\n`,
};

/** A JSON array, one entry per item. */
export function jsonArrayCodec<T>(): Codec<T[]> {
  return {
    parse: (body) => JSON.parse(body) as T[],
    format: (items) => `${JSON.stringify(items)}\n`,
  };
}

interface ArtifactSpec<T> {
  writers: readonly StepName[];
  readers: readonly StepName[];
  codec?: Codec<T>;
  external?: boolean;
  summarize(value: T): string;
}

export function artifact(kind: string, spec: ArtifactSpec<string>): Artifact<string>;
export function artifact<T>(kind: string, spec: ArtifactSpec<T> & { codec: Codec<T> }): Artifact<T>;
export function artifact<T>(kind: string, spec: ArtifactSpec<T>): Artifact<T> {
  const codec = spec.codec ?? (textCodec as unknown as Codec<T>);
  return {
    kind,
    writers: spec.writers,
    readers: spec.readers,
    ...(spec.external ? { external: true } : {}),
    summarize: (value) => spec.summarize(value).slice(0, SUMMARY_CHARS),
    parse: (body) => codec.parse(body),
    format: (value) => codec.format(value),
  };
}

/** Kinds that share a prefix, such as `review_<reviewer>`. */
export function artifactFamily(prefix: string, members: readonly string[]): ArtifactFamily {
  const kinds = members.map((member) => `${prefix}${member}`);
  return {
    prefix,
    of: (suffix) => `${prefix}${suffix}`,
    kinds,
    matches: (kind) => kinds.includes(kind),
  };
}
