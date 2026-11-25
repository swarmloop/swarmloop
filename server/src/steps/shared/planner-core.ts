import { readFileSync } from 'fs';
import { join } from 'path';

/** The skill line that stands for the core text of the planners. */
export const PLANNER_CORE_MARK = '[planner core]';

/** The one copy of the rules the three planners share, read from `skills/plan/planner-core.md`. */
export function plannerCore(): string {
  return readFileSync(join(__dirname, '../../../../skills', 'plan', 'planner-core.md'), 'utf8').trimEnd();
}
