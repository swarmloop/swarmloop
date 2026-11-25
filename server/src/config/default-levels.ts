import type { Effort } from '../contract/effort';
import { isEffort } from '../contract/effort';
import { SwarmloopError } from '../core/swarmloop-error';
import { readDefaultSettings } from './default-settings';

let levels: Map<string, Effort> | undefined;

/** The effort of the first entry of each agent list in defaults.env, read once. */
function defaultLevels(): Map<string, Effort> {
  if (!levels) {
    levels = new Map();
    for (const [name, value] of Object.entries(readDefaultSettings())) {
      const tail = value.split(',')[0].split(':').pop()?.trim() ?? '';
      if (name.startsWith('AGENTS_') && isEffort(tail)) {
        levels.set(name, tail);
      }
    }
  }
  return levels;
}

/** The level a first entry without an effort runs at: that of the first entry of the same list in defaults.env. */
export function defaultLevelOf(listName: string): Effort {
  const level = defaultLevels().get(listName);
  if (!level) {
    throw new SwarmloopError(`defaults.env gives the first agent of ${listName} no effort`);
  }
  return level;
}
