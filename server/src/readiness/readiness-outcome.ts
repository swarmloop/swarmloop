import type { ReadinessItem } from '../contract/readiness';
import type { RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';

export type Outcome = Omit<ReadinessItem, 'id'>;

const NOTHING = 'nothing to do';
const RANK: Record<Outcome['status'], number> = { ok: 0, warn: 1, fail: 2 };

export function ok(line: string): Outcome {
  return { status: 'ok', line, action: NOTHING };
}

/** A runtime with no credential: the item links to its card on the Connections page. */
export function missingModelCredential(runtime: RuntimeName, line: string): Outcome {
  return { status: 'fail', line, action: `connect ${runtime} in Connections`, link: `/connections#${runtime}` };
}

/** The most severe of several outcomes, with every line kept. */
export function worst(outcomes: Outcome[]): Outcome {
  const top = outcomes.reduce((a, b) => (RANK[b.status] > RANK[a.status] ? b : a));
  return { ...top, line: outcomes.map((outcome) => outcome.line).join('; ') };
}
