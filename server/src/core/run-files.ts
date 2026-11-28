import { readdir } from 'fs/promises';
import { join } from 'path';
import { STEPS, STORED_REVIEW_STEPS } from '../contract/steps';

/** Every step that writes an output file. */
export const OUTPUT_STEPS: readonly string[] = [...STEPS, ...STORED_REVIEW_STEPS, 'code-review-report', 'chat'];

const OUTPUT_STEP_SET: ReadonlySet<string> = new Set(OUTPUT_STEPS);

/** For each step, the suffixes of its sibling steps ("code-review" has "report"): an id that starts so is the file of the sibling. */
const SIBLING_SUFFIXES: ReadonlyMap<string, readonly string[]> = new Map(
  [...STEPS, ...STORED_REVIEW_STEPS].map((step) => [
    step,
    [...STEPS, ...STORED_REVIEW_STEPS]
      .filter((other) => other !== step && other.startsWith(`${step}-`))
      .map((other) => other.slice(step.length + 1)),
  ]),
);

/** True when the id is a non-empty id of an attempt of this step, not the start of a sibling step's name. */
export function isAttemptId(step: string, id: string): boolean {
  return (
    id !== '' && !(SIBLING_SUFFIXES.get(step) ?? []).some((sibling) => id === sibling || id.startsWith(`${sibling}-`))
  );
}

/** The kinds of file swarmloop writes for a run in `data/`. */
type RunFileKind = 'output' | 'launches' | 'session' | 'check-output' | 'logs';

const SUFFIXES = {
  output: '-output.txt',
  launches: '-launches.txt',
  session: '-session.json',
  'check-output': '-log.txt',
} as const;

const LOG_FOLDER = 'run-logs/';
/** The flat check command file of a run from before the log folder: `checks-<attempt>-command-<n>-log.txt`. */
const FLAT_CHECK_OUTPUT = /^checks-(?:.*-)?command-\d+-log\.txt$/;

/** The name of a run's file in `data/`: every writer names its file through this. */
export function runFileName(key: string, body: string, kind: Exclude<RunFileKind, 'logs'>): string {
  return `${key}-${body}${SUFFIXES[kind]}`;
}

interface Match {
  key: string;
  kind: RunFileKind;
  step: string;
  exact: boolean;
}

/** The names in `data/` and the folders of `data/run-logs/` as `run-logs/<name>`; none for a folder that is missing. */
export async function listRunEntries(root: string): Promise<string[]> {
  const names = await readdir(join(root, 'data')).catch(() => []);
  const logs = await readdir(join(root, 'data', 'run-logs'), { withFileTypes: true }).catch(() => []);
  return [...names, ...logs.filter((entry) => entry.isDirectory()).map((entry) => `${LOG_FOLDER}${entry.name}`)];
}

/**
 * The run an entry of `data/` belongs to and its kind. A file belongs to the run whose key it matches best, not to a
 * run whose key is only a prefix of it. The shared names and a later `<key>--N` session of another run are no run's.
 */
export function runFileOwner(entry: string, keys: ReadonlySet<string>): { key: string; kind: RunFileKind } | null {
  if (entry.startsWith(LOG_FOLDER)) {
    const key = entry.slice(LOG_FOLDER.length);
    return keys.has(key) ? { key, kind: 'logs' } : null;
  }
  if (isShared(entry)) {
    return null;
  }
  let best: Match | null = null;
  for (let at = entry.indexOf('-'); at !== -1; at = entry.indexOf('-', at + 1)) {
    const key = entry.slice(0, at);
    if (!keys.has(key) || entry[at + 1] === '-') {
      continue;
    }
    const match = fileMatch(key, entry.slice(at + 1));
    if (match && (!best || better(match, best))) {
      best = match;
    }
  }
  return best && { key: best.key, kind: best.kind };
}

function isShared(name: string): boolean {
  return name === 'agent-state' || name === 'swarmloop-empty-env' || name.startsWith('price-cache-');
}

function better(next: Match, best: Match): boolean {
  if (next.exact !== best.exact) {
    return next.exact;
  }
  if (next.step.length !== best.step.length) {
    return next.step.length > best.step.length;
  }
  return next.key.length > best.key.length;
}

/** What the part of a name after `<key>-` is: its kind, its step and whether the step is the whole body. */
function fileMatch(key: string, rest: string): Match | null {
  if (FLAT_CHECK_OUTPUT.test(rest)) {
    return { key, kind: 'check-output', step: 'checks', exact: false };
  }
  for (const kind of ['output', 'launches', 'session'] as const) {
    if (rest.endsWith(SUFFIXES[kind])) {
      const step = bodyStep(kind, rest.slice(0, -SUFFIXES[kind].length));
      return step && { key, kind, ...step };
    }
  }
  return null;
}

function bodyStep(kind: 'output' | 'launches' | 'session', body: string): { step: string; exact: boolean } | null {
  if (OUTPUT_STEP_SET.has(body) || (kind === 'output' && body === 'setup')) {
    return { step: body, exact: true };
  }
  if (kind === 'session') {
    return null;
  }
  let best: string | null = null;
  for (let at = body.indexOf('-'); at !== -1; at = body.indexOf('-', at + 1)) {
    const step = body.slice(0, at);
    if (OUTPUT_STEP_SET.has(step) && isAttemptId(step, body.slice(at + 1))) {
      best = step;
    }
  }
  if (best) {
    return { step: best, exact: false };
  }
  return kind === 'output' && body.endsWith('-setup') ? { step: 'setup', exact: false } : null;
}
