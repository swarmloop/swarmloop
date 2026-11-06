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
}

export interface ArtifactFamily {
  prefix: string;
  of(suffix: string): string;
  kinds: readonly string[];
  matches(kind: string): boolean;
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
