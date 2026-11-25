import type Joi from 'joi';
import type { ResultDefinition } from './result-definition';

export const RESULT_AS_BEFORE = 'End with the result block as before.';

export interface Described {
  type?: string;
  flags?: { presence?: string; description?: string };
  keys?: Record<string, Described>;
  items?: Described[];
  allow?: unknown[];
  matches?: { schema: Described }[];
  metas?: unknown[];
}

export function typeOf(node: Described): string {
  if (node.type === 'array') {
    return `array of ${node.items?.[0] ? typeOf(node.items[0]) : 'values'}`;
  }
  const choices = node.allow?.filter((item) => typeof item === 'string');
  return choices?.length ? `one of ${choices.map((item) => JSON.stringify(item)).join(', ')}` : (node.type ?? 'any');
}

/** The line of one field: its path, type, whether it is required, and its description. */
export function fieldLine(path: string, node: Described): string {
  const required = node.flags?.presence === 'required' ? 'required' : 'optional';
  const description = node.flags?.description ? `: ${node.flags.description}` : '';
  return `- ${path} (${typeOf(node)}, ${required})${description}`;
}

function fieldLines(path: string, node: Described, lines: string[]): void {
  lines.push(fieldLine(path, node));
  const inner = node.type === 'array' ? node.items?.[0] : node;
  const prefix = node.type === 'array' ? `${path}[]` : path;
  for (const [key, child] of Object.entries(inner?.keys ?? {})) {
    fieldLines(`${prefix}.${key}`, child, lines);
  }
}

/** The description of a definition's schema. */
export function describeResult(definition: ResultDefinition): Described {
  return (definition.schema as Joi.Schema).describe();
}

/** One line for every field of a definition, nested fields included. */
export function resultFieldLines(definition: ResultDefinition): string[] {
  const lines: string[] = [];
  for (const [key, child] of Object.entries(describeResult(definition).keys ?? {})) {
    fieldLines(key, child, lines);
  }
  return lines;
}

/** The part of a prompt that tells the agent what to send, written from the schema itself. */
export function resultPrompt(definition: ResultDefinition): string {
  return [
    'End your final message with exactly one result block: a line of three backticks followed by json, one JSON object, then a line of three backticks.',
    'The text before the block is for people and is never read. The object has these fields, and no others:',
    ...resultFieldLines(definition),
  ].join('\n');
}

/** The full text for a chat that has not received this definition; one line for a chat that has. */
export function resultPromptFor(definition: ResultDefinition, received: string | null): string {
  return received === definition.name ? RESULT_AS_BEFORE : resultPrompt(definition);
}
