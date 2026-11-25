import { isUnreadableBlockError } from '../contract/result-block';
import type { ResultDefinition } from './result-definition';
import { definitionPart } from './result-part';
import { RESULT_AS_BEFORE, resultFieldLines } from './result-prompt';

/** The lines of the definition that one error is about: the field list for an unreadable block, else the part its path names. */
function partOf(error: string, definition: ResultDefinition): string[] {
  if (isUnreadableBlockError(error)) {
    return resultFieldLines(definition);
  }
  const at = error.indexOf(': ');
  return at < 0 ? [] : (definitionPart(definition, error.slice(0, at)) ?? []);
}

/**
 * The one follow-up for an answer the server could not accept: every error, and under each the part of the definition
 * it is about, shown once. Nothing of the skill or the rules. An error that names no part keeps its line alone.
 */
export function resultFollowUp(errors: string[], definition: ResultDefinition | undefined): string {
  const shown = new Set<string>();
  const lines = errors.flatMap((error) => {
    const part = (definition ? partOf(error, definition) : []).filter((line) => !shown.has(line));
    part.forEach((line) => shown.add(line));
    return [`- ${error}`, ...part.map((line) => `  ${line}`)];
  });
  return [
    'The result block of your last answer was not accepted:',
    ...lines,
    '',
    `Send the result block again and change nothing else. ${RESULT_AS_BEFORE}`,
  ].join('\n');
}
