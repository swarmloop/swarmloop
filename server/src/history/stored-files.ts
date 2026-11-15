import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { REVIEW_STEPS, STEPS } from '../contract/steps';
import { runLogDir } from '../core/run-logs';
import { removeTree } from './run-paths';
import { sessionHome } from './session-group';

const DATA_STEPS = [...STEPS, ...REVIEW_STEPS, 'code-review-report', 'chat'];

/** This id's step files. The longer step name wins, a later `<key>--N` session stays, and the shared data names stay. */
function ownedDataFile(key: string, name: string, keys: readonly string[]): boolean {
  if (sharedDataName(name) || !name.startsWith(`${key}-`) || name.startsWith(`${key}--`)) {
    return false;
  }
  return dataFileOwner(name, keys) === key;
}

function dataFileOwner(name: string, keys: readonly string[]): string | null {
  let best: { key: string; step: string; exact: boolean } | null = null;
  for (const candidate of keys) {
    const match = dataFileMatch(candidate, name);
    if (match && (!best || betterMatch(match, best))) {
      best = match;
    }
  }
  return best?.key ?? null;
}

function betterMatch(
  next: { key: string; step: string; exact: boolean },
  best: { key: string; step: string; exact: boolean },
): boolean {
  if (next.exact !== best.exact) {
    return next.exact;
  }
  if (next.step.length !== best.step.length) {
    return next.step.length > best.step.length;
  }
  return next.key.length > best.key.length;
}

function dataFileMatch(key: string, name: string): { key: string; step: string; exact: boolean } | null {
  if (!name.startsWith(`${key}-`) || name.startsWith(`${key}--`)) {
    return null;
  }
  const rest = name.slice(key.length + 1);
  const body = rest.endsWith('-output.txt')
    ? rest.slice(0, -'-output.txt'.length)
    : rest.endsWith('-launches.txt')
      ? rest.slice(0, -'-launches.txt'.length)
      : rest.endsWith('-session.json')
        ? rest.slice(0, -'-session.json'.length)
        : null;
  if (body === null) {
    return null;
  }
  const step = rest.endsWith('-session.json') ? sessionMatch(body) : stepMatch(body);
  return step ? { key, ...step } : null;
}

function stepMatch(body: string): { step: string; exact: boolean } | null {
  let best: { step: string; exact: boolean } | null = null;
  for (const step of DATA_STEPS) {
    const exact = body === step;
    if (!exact && !body.startsWith(`${step}-`)) {
      continue;
    }
    if (!best || (exact !== best.exact ? exact : step.length > best.step.length)) {
      best = { step, exact };
    }
  }
  return best;
}

function sessionMatch(body: string): { step: string; exact: boolean } | null {
  return DATA_STEPS.some((step) => sessionHome(step) === body) ? { step: body, exact: true } : null;
}

function sharedDataName(name: string): boolean {
  return name === 'agent-state' || name === 'swarmloop-empty-env' || name.startsWith('price-cache-');
}

/** The files, session state, log folder and run folder swarmloop stored for one run. */
export function removeStoredFiles(root: string, key: string, keys: readonly string[]): void {
  const data = join(root, 'data');
  if (existsSync(data)) {
    for (const name of readdirSync(data)) {
      if (ownedDataFile(key, name, keys)) {
        removeTree(join(data, name));
      }
    }
  }
  removeTree(join(root, 'data', 'agent-state', key));
  removeTree(runLogDir(root, key));
  removeTree(join(root, 'runs', key));
}
