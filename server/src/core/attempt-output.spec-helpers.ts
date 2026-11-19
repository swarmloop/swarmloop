import { REVIEW_STEPS, STEPS } from '../contract/steps';

const OUTPUT_STEPS = [...STEPS, ...REVIEW_STEPS, 'code-review-report', 'chat'];

/** Today's attempt-file rule before the matcher was built once per run key, kept as the reference for the equivalence spec. */
function referenceIsAttemptFile(name: string, key: string, step: string): boolean {
  const prefix = `${key}-${step}-`;
  const suffix = '-output.txt';
  if (!name.startsWith(prefix) || !name.endsWith(suffix) || name.length <= prefix.length + suffix.length) {
    return false;
  }
  const id = name.slice(prefix.length, name.length - suffix.length);
  return ![...STEPS, ...REVIEW_STEPS].some(
    (other) =>
      other !== step &&
      other.startsWith(`${step}-`) &&
      (id === other.slice(step.length + 1) || id.startsWith(`${other.slice(step.length + 1)}-`)),
  );
}

/** Today's `isOutputFileOf`: every step is tried against the name. */
export function referenceIsOutputFileOf(name: string, key: string): boolean {
  return OUTPUT_STEPS.some((step) => name === `${key}-${step}-output.txt` || referenceIsAttemptFile(name, key, step));
}

export const FIXTURE_KEYS = ['K-1', 'K-1-a', 'K-10', 'run'];

/** 2 000 names, the same on every call: every output step, ids that look like sibling steps, wrong suffixes, empty ids. */
export function outputNameFixture(): string[] {
  const ids = ['abc', '1f2e-3d4c', 'report', 'report-x', 'quality', 'quality-1', 'a-b-c', '', 'chat', 'plan-9'];
  const tails = ['-output.txt', '-output.txt', '-output.txt', '-output.log', '-output', ''];
  const names: string[] = [];
  for (let n = 0; names.length < 2000; n += 1) {
    const key = FIXTURE_KEYS[n % FIXTURE_KEYS.length];
    const step = OUTPUT_STEPS[Math.floor(n / 3) % OUTPUT_STEPS.length];
    const id = ids[Math.floor(n / 7) % ids.length];
    const tail = tails[Math.floor(n / 11) % tails.length];
    const owner = n % 13 === 0 ? FIXTURE_KEYS[(n + 1) % FIXTURE_KEYS.length] : key;
    names.push(id ? `${owner}-${step}-${id}${tail}` : `${owner}-${step}${tail === '-output.txt' ? '' : '-'}${tail}`);
  }
  names.push('swarmloop.sqlite', 'K-1-check-output.txt', 'K-1-output.txt', '-output.txt', 'K--output.txt');
  return names;
}
