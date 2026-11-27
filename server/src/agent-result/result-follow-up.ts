import { isUnreadableBlockError } from '../contract/result-block';
import type { ResultDefinition } from './result-definition';
import { definitionPart } from './result-part';
import { resultFieldLines } from './result-prompt';

/** The path and the message of an error, or null for one that names no path, such as a check of the server. */
function splitError(error: string): { path: string; message: string } | null {
  const at = error.indexOf(': ');
  const path = at < 0 ? '' : error.slice(0, at);
  return path === '' || /\s/.test(path) ? null : { path, message: error.slice(at + 2) };
}

/** The lines of the definition that one error is about: the field list for an unreadable block, else the part its path names. */
function partOf(error: string, definition: ResultDefinition): string[] {
  if (isUnreadableBlockError(error)) {
    return resultFieldLines(definition);
  }
  const split = splitError(error);
  return split ? (definitionPart(definition, split.path) ?? []) : [];
}

interface ErrorGroup {
  /** The path and message with every index written as `[]`; the whole error when it names no path. */
  heading: string;
  errors: string[];
}

/** Errors that say the same of one key in different places form one group; an error with no path is its own group. */
function groupErrors(errors: string[]): ErrorGroup[] {
  const groups = new Map<string, ErrorGroup>();
  errors.forEach((error, index) => {
    const split = splitError(error);
    const heading = split
      ? `${split.path.replace(/\.\d+(?=\.|$)/g, '[]')}: ${split.message.replace(/\[\d+\]/g, '[]')}`
      : error;
    const key = split ? heading : `${index}`;
    const group = groups.get(key) ?? { heading, errors: [] };
    group.errors.push(error);
    groups.set(key, group);
  });
  return [...groups.values()];
}

/** The line of a group: the error itself for one place, else the grouped error with every place it is about. */
function groupLine(group: ErrorGroup): string {
  if (group.errors.length === 1) {
    return `- ${group.errors[0]}`;
  }
  const places = group.errors.map((error) => splitError(error)?.path ?? error);
  return `- ${group.heading} (${places.length} places: ${places.join(', ')})`;
}

/**
 * The one follow-up for an answer the server could not accept: every error, those that say the same of one key in
 * several places as one line with all the places, and under each line the part of the definition it is about, shown
 * once. Nothing of the skill or the rules, and no line is cut. An error that names no part keeps its line alone.
 */
export function resultFollowUp(errors: string[], definition: ResultDefinition | undefined): string {
  const shown = new Set<string>();
  const lines = groupErrors(errors).flatMap((group) => {
    const part = (definition ? partOf(group.errors[0], definition) : []).filter((line) => !shown.has(line));
    part.forEach((line) => shown.add(line));
    return [groupLine(group), ...part.map((line) => `  ${line}`)];
  });
  return [
    'The result block of your last answer was not accepted:',
    ...lines,
    '',
    'Answer with the result block only, with nothing before or after it, and change nothing else in it.',
  ].join('\n');
}
