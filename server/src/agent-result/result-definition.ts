import type Joi from 'joi';

/** What one step hands to the server: a name, the document kind its validated object is stored under, and the schema. */
export interface ResultDefinition {
  name: string;
  kind: string;
  schema: Joi.ObjectSchema;
}

const SUFFIX = '_result';

export function defineResult(name: string, schema: Joi.ObjectSchema): ResultDefinition {
  return { name, kind: `${name}${SUFFIX}`, schema };
}

/** True for the kind of a stored result object, which the run history leaves out. */
export function isResultKind(kind: string): boolean {
  return kind.endsWith(SUFFIX);
}
