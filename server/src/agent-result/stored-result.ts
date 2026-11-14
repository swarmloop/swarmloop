import { resultArtifactCodec } from './result-codec';
import type { ResultDefinition } from './result-definition';

interface StoredDocument {
  kind: string;
  body: string;
}

/**
 * The latest stored value of a definition's kind among the documents of a run, in the order they were written.
 * It is read through the codec of the registry, so a body that the definition does not accept throws.
 */
export function storedResult<T>(definition: ResultDefinition, documents: StoredDocument[]): T | null {
  const latest = [...documents].reverse().find((document) => document.kind === definition.kind);
  return latest ? resultArtifactCodec<T>(definition).parse(latest.body) : null;
}
