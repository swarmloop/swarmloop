import type { MergeMode } from '../../contract/backlog';
import type { RepositoryHost } from '../../steps/shared/repository-host';
import type { MainReading } from './task-readiness';

/** What the host says of a merge request, with the names of the checks that fail and that still run on its head. */
type GateReading = Awaited<ReturnType<RepositoryHost['gate']>>;

export interface MergeFacts {
  mode: MergeMode;
  manual: boolean;
  /** The owner said this task may merge. */
  mergeOk: boolean;
  gate: GateReading;
  /** The repository the request is for, and how its main reads; null when it was not read. */
  repository: string;
  main: MainReading | undefined;
  /** The task repairs the main of this very repository. */
  fixesMainHere: boolean;
  /** A rebase was already sent for this head. */
  rebaseSent: boolean;
  /** The branch of the run in this repository. */
  branch: string;
}

type MergeDecision =
  | { kind: 'wait'; note: string }
  | { kind: 'rebase' }
  | { kind: 'person'; note: string }
  | { kind: 'merge'; head: string }
  | { kind: 'merged'; sha: string };

export const CLOSED_NOTE = 'its merge request was closed without a merge';

/** What a request that is still behind after a rebase asks of a person. */
function stillBehind(branch: string): string {
  return `still behind ${branch} after a rebase; needs a person`;
}

/** What a request that still conflicts after a rebase says: the run's implement agent resolves it. */
export function conflictSent(branch: string): string {
  return `conflicts with ${branch} after a rebase; the implement agent resolves it`;
}

function mainNote(repository: string, main: MainReading | undefined): string | null {
  if (main?.state === 'green') return null;
  const base = `waits for a green main of ${repository}`;
  return main?.state === 'unreadable' ? `${base}: ${main.note}` : base;
}

/**
 * What to do with one merge request of a done run, by the queue runner's rules in their order. The checks come before
 * the reviews because the host's `blocked` also covers required checks.
 */
export function decideMerge(facts: MergeFacts): MergeDecision {
  const { gate } = facts;
  if (gate.state === 'closed') return { kind: 'person', note: CLOSED_NOTE };
  if (gate.state === 'merged') return { kind: 'merged', sha: gate.sha ?? gate.head };
  if (gate.draft) return { kind: 'wait', note: 'waits for its merge request to leave draft' };
  if (gate.mergeability === 'unknown') return { kind: 'wait', note: 'waits for the host to tell whether it merges' };
  if (gate.mergeability === 'conflicting' && facts.rebaseSent)
    return { kind: 'wait', note: conflictSent(facts.branch) };
  if (gate.mergeability === 'behind' || gate.mergeability === 'conflicting') {
    return facts.rebaseSent ? { kind: 'person', note: stillBehind(facts.branch) } : { kind: 'rebase' };
  }
  if (gate.failing.length > 0)
    return { kind: 'person', note: `checks failing: ${gate.failing.join(', ')}; needs a person` };
  if (gate.pending.length > 0)
    return { kind: 'person', note: `checks pending: ${gate.pending.join(', ')}; needs a person` };
  if (gate.mergeability === 'blocked') {
    return { kind: 'person', note: `reviews: ${gate.blockedBy ?? 'blocked'}; needs a person` };
  }
  const main = facts.fixesMainHere ? null : mainNote(facts.repository, facts.main);
  if (main) return { kind: 'wait', note: main };
  if ((facts.mode === 'ok' || facts.manual) && !facts.mergeOk) {
    return { kind: 'wait', note: 'waits for your OK to merge' };
  }
  return { kind: 'merge', head: gate.head };
}
