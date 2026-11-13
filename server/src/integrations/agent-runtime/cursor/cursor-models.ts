import { EFFORTS, type Effort } from '../../../contract/effort';

/** The words Cursor puts at the end of a model id for a level, the first one taken first. */
const SUFFIXES: Record<Effort, readonly string[]> = {
  low: ['low'],
  medium: ['medium'],
  high: ['high'],
  xhigh: ['xhigh', 'extra-high'],
  max: ['max'],
};

/** The ids in the output of the CLI's model list, one `<id> - <name>` per line. */
export function parseModelIds(cliOutput: string): string[] {
  const ids: string[] = [];
  for (const line of cliOutput.split('\n')) {
    const id = /^([a-z0-9][a-z0-9._-]*)\s+-\s/i.exec(line.trim())?.[1];
    if (id) {
      ids.push(id);
    }
  }
  return ids;
}

function endsInLevel(id: string): boolean {
  return EFFORTS.some((level) => SUFFIXES[level].some((suffix) => id.endsWith(`-${suffix}`)));
}

/** The id Cursor uses for `model` at `level`, or null when the list has none. */
export function idWithEffort(ids: readonly string[], model: string, level: Effort): string | null {
  if (!ids.includes(model) || endsInLevel(model)) {
    return null;
  }
  const found = SUFFIXES[level].map((suffix) => `${model}-${suffix}`).find((id) => ids.includes(id));
  return found ?? null;
}

/** The levels for which `model` has an id. An id that already ends in a level has none. */
export function effortsOf(ids: readonly string[], model: string): Effort[] {
  return EFFORTS.filter((level) => idWithEffort(ids, model, level) !== null);
}
