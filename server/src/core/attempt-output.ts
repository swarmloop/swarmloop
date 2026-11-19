import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import { readdir } from 'fs/promises';
import { join, resolve, sep } from 'path';
import { REVIEW_STEPS, STEPS } from '../contract/steps';

/** The output file of one attempt of a step. A relaunch of the step writes another file. */
export function attemptOutputPath(root: string, key: string, step: string, attemptId: string): string {
  return join(root, 'data', `${key}-${step}-${attemptId}-output.txt`);
}

/** The output file to write for an attempt. A launch without an attempt keeps today's name. */
export function outputFileFor(root: string, key: string, step: string, attemptId: string | null): string {
  return attemptId ? attemptOutputPath(root, key, step, attemptId) : join(root, 'data', `${key}-${step}-output.txt`);
}

/** For each step, the suffixes of its sibling steps ("code-review" has "report"): an id that starts so is the file of the sibling. */
const SIBLING_SUFFIXES: ReadonlyMap<string, readonly string[]> = new Map(
  [...STEPS, ...REVIEW_STEPS].map((step) => [
    step,
    [...STEPS, ...REVIEW_STEPS]
      .filter((other) => other !== step && other.startsWith(`${step}-`))
      .map((other) => other.slice(step.length + 1)),
  ]),
);

const OUTPUT_SUFFIX = '-output.txt';

/** True when the id is a non-empty id of an attempt of this step, not the start of a sibling step's name. */
function isAttemptId(step: string, id: string): boolean {
  return (
    id !== '' && !(SIBLING_SUFFIXES.get(step) ?? []).some((sibling) => id === sibling || id.startsWith(`${sibling}-`))
  );
}

/** An attempt file of this step: a non-empty id between the step and the suffix, not the file of a sibling step. */
function isAttemptFile(name: string, key: string, step: string): boolean {
  const prefix = `${key}-${step}-`;
  if (
    !name.startsWith(prefix) ||
    !name.endsWith(OUTPUT_SUFFIX) ||
    name.length <= prefix.length + OUTPUT_SUFFIX.length
  ) {
    return false;
  }
  return isAttemptId(step, name.slice(prefix.length, name.length - OUTPUT_SUFFIX.length));
}

/** Every step that writes an output file. */
export const OUTPUT_STEPS: readonly string[] = [...STEPS, ...REVIEW_STEPS, 'code-review-report', 'chat'];

const OUTPUT_STEP_SET: ReadonlySet<string> = new Set(OUTPUT_STEPS);

/** The matcher of one run key: a name is split at its hyphens once, not tried against every step. */
function outputMatcher(key: string): (name: string) => boolean {
  const prefix = `${key}-`;
  return (name) => {
    if (
      !name.startsWith(prefix) ||
      !name.endsWith(OUTPUT_SUFFIX) ||
      name.length < prefix.length + OUTPUT_SUFFIX.length
    ) {
      return false;
    }
    const middle = name.slice(prefix.length, name.length - OUTPUT_SUFFIX.length);
    if (OUTPUT_STEP_SET.has(middle)) {
      return true;
    }
    for (let at = middle.indexOf('-'); at !== -1; at = middle.indexOf('-', at + 1)) {
      if (OUTPUT_STEP_SET.has(middle.slice(0, at)) && isAttemptId(middle.slice(0, at), middle.slice(at + 1))) {
        return true;
      }
    }
    return false;
  };
}

let lastMatcher: { key: string; matches: (name: string) => boolean } | undefined;

/** True for any output file of this run: one per attempt, or the single file of a run from before attempts. */
export function isOutputFileOf(name: string, key: string): boolean {
  if (lastMatcher?.key !== key) {
    lastMatcher = { key, matches: outputMatcher(key) };
  }
  return lastMatcher.matches(name);
}

/** The attempt ids a run's flow knows: every stored attempt of any step (reviewers write under the code-review id) and the active one. */
export function knownAttempts(activeAttempt: string | null, stats: readonly { attemptId: string | null }[]): string[] {
  const ids = new Set<string>();
  for (const stat of stats) {
    if (stat.attemptId) {
      ids.add(stat.attemptId);
    }
  }
  if (activeAttempt) {
    ids.add(activeAttempt);
  }
  return [...ids];
}

/** The names in `data/`, read without blocking the main thread; none when the folder cannot be read. */
export async function listOutputNames(root: string): Promise<string[]> {
  try {
    return await readdir(join(root, 'data'));
  } catch {
    return [];
  }
}

/** Where the lookups find the files: the attempt ids the database holds, or the names of `data/` listed beforehand. */
type OutputSource = { attempts: readonly string[] } | { names: readonly string[] };

/**
 * The output files of one root for the lookups of one flow. With known attempt ids it checks their exact
 * paths and lists nothing. Without them it lists `data/` at most once (a run from before attempts), so a
 * file written afterwards is not seen by it.
 */
export class OutputFiles {
  private names: readonly string[] | undefined;

  constructor(
    readonly root: string,
    private readonly source?: OutputSource,
  ) {}

  /** The file of one attempt, else (without an id) the newest attempt file, else the single file of a run from before attempts. */
  path(key: string, step: string, attemptId: string | null): string | null {
    const own = attemptId ? this.existing(attemptOutputPath(this.root, key, step, attemptId)) : null;
    if (own) {
      return own;
    }
    const files = this.attemptFiles(key, step);
    if (files.length > 0) {
      return attemptId ? null : join(this.root, 'data', files[0].name);
    }
    return this.existing(outputFileFor(this.root, key, step, null));
  }

  /** The file as an absolute path when it exists inside `data/`; a key, step or attempt id that points elsewhere is never looked up. */
  private existing(file: string): string | null {
    const inside = resolve(file);
    return inside.startsWith(resolve(this.root, 'data') + sep) && existsSync(inside) ? inside : null;
  }

  /** What one attempt of a step wrote. Never the output of two attempts joined. */
  read(key: string, step: string, attemptId: string | null): string {
    const path = this.path(key, step, attemptId);
    return path ? readFile(path) : '';
  }

  /** The attempt ids that have an output file for this step, newest first. */
  attemptIds(key: string, step: string): string[] {
    const prefix = `${key}-${step}-`;
    return this.attemptFiles(key, step).map((file) => file.name.slice(prefix.length, -OUTPUT_SUFFIX.length));
  }

  /** The names to check: the known attempts' files that exist, else the listed names, else one listing of `data/`. */
  private candidates(key: string, step: string): readonly string[] {
    if (this.source && 'attempts' in this.source && this.source.attempts.length > 0) {
      return this.source.attempts
        .map((id) => `${key}-${step}-${id}${OUTPUT_SUFFIX}`)
        .filter((name) => this.existing(join(this.root, 'data', name)));
    }
    if (this.source && 'names' in this.source) {
      return this.source.names;
    }
    const directory = join(this.root, 'data');
    this.names ??= existsSync(directory) ? readdirSync(directory) : [];
    return this.names;
  }

  private attemptFiles(key: string, step: string): { name: string; mtimeMs: number }[] {
    const directory = join(this.root, 'data');
    return this.candidates(key, step)
      .filter((name) => isAttemptFile(name, key, step))
      .map((name) => ({ name, mtimeMs: modifiedAt(join(directory, name)) }))
      .sort((a, b) => b.mtimeMs - a.mtimeMs);
  }
}

export function stepOutputPath(
  root: string,
  key: string,
  step: string,
  attemptId: string | null,
  known?: readonly string[],
): string | null {
  return new OutputFiles(root, known && { attempts: known }).path(key, step, attemptId);
}

/** The attempt ids that have an output file for this step, newest first. */
export function attemptIdsOf(root: string, key: string, step: string, known?: readonly string[]): string[] {
  return new OutputFiles(root, known && { attempts: known }).attemptIds(key, step);
}

/** What one attempt of a step wrote. Never the output of two attempts joined. */
export function stepOutput(
  root: string,
  key: string,
  step: string,
  attemptId: string | null,
  known?: readonly string[],
): string {
  return new OutputFiles(root, known && { attempts: known }).read(key, step, attemptId);
}

/** A file removed while the directory is scanned counts as the oldest. */
function modifiedAt(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function readFile(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

/** True when the agent wrote its final result line. */
export function hasFinalResult(output: string): boolean {
  return output.split('\n').some((line) => line.startsWith('{"type":"result"'));
}
