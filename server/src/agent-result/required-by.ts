import type Joi from 'joi';

/** The fields each choice of one field needs; it is the one list the check and the follow-up both read. */
export interface RequiredBy {
  field: string;
  needs: Record<string, string[]>;
}

/**
 * An object whose `field` is a choice, and each choice needs the fields listed for it. The object refuses a value that
 * misses one, and keeps the list in its description for `requiredByOf`.
 */
export function requiredBy(schema: Joi.ObjectSchema, field: string, needs: Record<string, string[]>): Joi.ObjectSchema {
  return schema
    .custom((value: Record<string, unknown>, helpers) => {
      const missing = needs[value[field] as string].filter((key) => value[key] === undefined);
      return missing.length > 0
        ? helpers.message({ custom: `${String(value[field])} needs ${missing.join(', ')}` })
        : value;
    })
    .meta({ requiredBy: { field, needs } satisfies RequiredBy });
}

/** The list `requiredBy` put into a described schema, or undefined. */
export function requiredByOf(node: { metas?: unknown[] }): RequiredBy | undefined {
  const found = node.metas?.find(
    (meta): meta is { requiredBy: RequiredBy } => typeof meta === 'object' && meta !== null && 'requiredBy' in meta,
  );
  return found?.requiredBy;
}
