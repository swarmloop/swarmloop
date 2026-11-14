import type { ResultDefinition } from './result-definition';

interface Codec<T> {
  parse(body: string): T;
  format(value: T): string;
}

/** The registry codec of a result kind: stored as JSON and validated by the same schema as the result block. */
export function resultArtifactCodec<T>(definition: ResultDefinition): Codec<T> {
  return {
    parse: (body) => {
      const checked = definition.schema.validate(JSON.parse(body), { abortEarly: false, allowUnknown: false });
      if (checked.error) {
        throw new Error(`${definition.kind} is not valid: ${checked.error.message}`);
      }
      return checked.value as T;
    },
    format: (value) => `${JSON.stringify(value)}\n`,
  };
}
