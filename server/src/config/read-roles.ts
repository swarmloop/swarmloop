import { CODE_REVIEWERS } from '../contract/steps';
import { SwarmloopError } from '../core/swarmloop-error';

/** The roles `READ_ROLES` can name: the ones whose agent can read through the reader list `AGENTS_READ`. */
const READ_ROLE_NAMES = [
  'backlog',
  'research',
  'plan',
  'plan-improve',
  'plan-answers',
  'code-review',
  'code-review-report',
  'implement',
  'implement-improve',
] as const;
type ReadRole = (typeof READ_ROLE_NAMES)[number];

/** The names `READ_ROLES` holds: comma-separated, trimmed, none for an empty value. */
export function readRolesOf(value: string): string[] {
  return value
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

/** Start-up check: every name of `READ_ROLES` is a role that can read through a reader. */
export function assertReadRoles(value: string): void {
  const unknown = readRolesOf(value).find((name) => !READ_ROLE_NAMES.some((role) => role === name));
  if (unknown !== undefined) {
    throw new SwarmloopError(`READ_ROLES has unknown role "${unknown}": the roles are ${READ_ROLE_NAMES.join(', ')}`);
  }
}

/** The role of `READ_ROLES` an agent use belongs to: every reviewer is `code-review`. Null for a use that has none. */
export function readRoleOf(use: string): ReadRole | null {
  if (CODE_REVIEWERS.some((reviewer) => `code-review-${reviewer}` === use)) {
    return 'code-review';
  }
  if (use === 'backlog-plan') {
    return 'backlog';
  }
  return READ_ROLE_NAMES.find((role) => role === use) ?? null;
}
