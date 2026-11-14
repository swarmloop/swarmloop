import type Joi from 'joi';
import type { ResultDefinition } from './result-definition';

export const RESULT_AS_BEFORE = 'End with the result block as before.';

interface Described {
  type?: string;
  flags?: { presence?: string; description?: string };
  keys?: Record<string, Described>;
  items?: Described[];
  allow?: unknown[];
  matches?: { schema: Described }[];
}

function typeOf(node: Described): string {
  if (node.type === 'array') {
    return `array of ${node.items?.[0] ? typeOf(node.items[0]) : 'values'}`;
  }
  const choices = node.allow?.filter((item) => typeof item === 'string');
  return choices?.length ? `one of ${choices.map((item) => JSON.stringify(item)).join(', ')}` : (node.type ?? 'any');
}

function fieldLines(path: string, node: Described, lines: string[]): void {
  const required = node.flags?.presence === 'required' ? 'required' : 'optional';
  const description = node.flags?.description ? `: ${node.flags.description}` : '';
  lines.push(`- ${path} (${typeOf(node)}, ${required})${description}`);
  const inner = node.type === 'array' ? node.items?.[0] : node;
  const prefix = node.type === 'array' ? `${path}[]` : path;
  for (const [key, child] of Object.entries(inner?.keys ?? {})) {
    fieldLines(`${prefix}.${key}`, child, lines);
  }
}

/** The part of a prompt that tells the agent what to send, written from the schema itself. */
export function resultPrompt(definition: ResultDefinition): string {
  const described = (definition.schema as Joi.Schema).describe() as Described;
  const lines: string[] = [];
  for (const [key, child] of Object.entries(described.keys ?? {})) {
    fieldLines(key, child, lines);
  }
  return [
    'End your final message with exactly one result block: a line of three backticks followed by json, one JSON object, then a line of three backticks.',
    'The text before the block is for people and is never read. The object has these fields, and no others:',
    ...lines,
  ].join('\n');
}

/** The full text for a chat that has not received this definition; one line for a chat that has. */
export function resultPromptFor(definition: ResultDefinition, received: string | null): string {
  return received === definition.name ? RESULT_AS_BEFORE : resultPrompt(definition);
}
