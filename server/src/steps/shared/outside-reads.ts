import { RUN_LOGS_PATH } from '../../core/run-logs';

/** A path outside the working directories that a prompt asks its agent to read. */
export interface OutsideRead {
  path: string;
  what: string;
}

/** The start of the line that tells an agent to stay inside its working directories. */
export const STAY_LINE_START = 'Do not look outside ';

const ALSO_READ_START = 'Also read, and nothing else outside: ';
const SKILL_FILE = /\/work\/brief\/skills\/[^\s`'")\]]+/g;
const BRIEF_PATH = /\/work\/brief\/[^\s`'")\]]*/g;
const TRAILING_PUNCTUATION = /[.,;:]+$/;

const LOGS_READ: OutsideRead = { path: `${RUN_LOGS_PATH}/`, what: 'the full logs of cut check and pipeline output' };

function distinct(reads: readonly OutsideRead[]): OutsideRead[] {
  return reads.filter((read, index) => reads.findIndex((other) => other.path === read.path) === index);
}

function entry(read: OutsideRead): string {
  return `${read.path} (${read.what})`;
}

/** The line that allows the named paths. Empty when nothing is named. */
export function alsoReadLine(reads: readonly OutsideRead[]): string {
  const listed = distinct(reads);
  return listed.length === 0 ? '' : `${ALSO_READ_START}${listed.map(entry).join(', ')}.`;
}

/**
 * The brief paths a prompt without a block names, other than those under an entry of `reads`. A line that opens
 * such a prompt allows them too, so it never forbids what the prompt asks for.
 */
function namedOutside(prompt: string, reads: readonly OutsideRead[]): OutsideRead[] {
  const paths = (prompt.match(BRIEF_PATH) ?? []).map((path) => path.replace(TRAILING_PUNCTUATION, ''));
  return [...new Set(paths)]
    .filter((path) => !reads.some((read) => path.startsWith(read.path)))
    .map((path) => ({ path, what: 'a file this prompt names' }));
}

/**
 * The prompt with the named paths allowed in its opening paragraph: added to its "Also read" line, else as a line before
 * its stay line, else as a first line.
 */
export function withOutsideReads(prompt: string, reads: readonly OutsideRead[]): string {
  if (reads.length === 0) {
    return prompt;
  }
  const split = prompt.indexOf('\n\n');
  const opening = (split < 0 ? prompt : prompt.slice(0, split)).split('\n');
  const rest = split < 0 ? '' : prompt.slice(split);
  const at = opening.findIndex((line) => line.startsWith(ALSO_READ_START));
  if (at >= 0) {
    const missing = distinct(reads).filter((read) => !opening[at].includes(`${read.path} (`));
    if (missing.length > 0) {
      opening[at] = `${opening[at].replace(/\.$/, '')}, ${missing.map(entry).join(', ')}.`;
    }
    return opening.join('\n') + rest;
  }
  const stay = opening.findIndex((line) => line.startsWith(STAY_LINE_START));
  if (stay < 0) {
    return `${alsoReadLine([...reads, ...namedOutside(prompt, reads)])}\n\n${prompt}`;
  }
  opening.splice(stay, 0, alsoReadLine(reads));
  return opening.join('\n') + rest;
}

/** One entry for each skill file under the brief folder that the text names. */
export function skillFileReads(text: string): OutsideRead[] {
  const paths = (text.match(SKILL_FILE) ?? []).map((path) => path.replace(TRAILING_PUNCTUATION, ''));
  return [...new Set(paths)].map((path) => ({ path, what: 'a skill file' }));
}

/** The prompt with the log folder allowed, when it names a path under it. */
export function withLogReads(prompt: string): string {
  return prompt.includes(`${RUN_LOGS_PATH}/`) ? withOutsideReads(prompt, [LOGS_READ]) : prompt;
}
