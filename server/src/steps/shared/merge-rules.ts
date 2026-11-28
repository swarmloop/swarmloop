import type { MergeMode } from '../../contract/backlog';
import type { RepositoryHost } from './repository-host';

/** What the host says of a merge request, with the names of the checks that fail and that still run on its head. */
type GateReading = Awaited<ReturnType<RepositoryHost['gate']>>;

/** What the target branch of a request adds to the rules: nothing for a feature branch, the main's own waits for a main. */
export type MergeTarget =
  | { kind: 'branch' }
  | {
      kind: 'main';
      mode: MergeMode;
      manual: boolean;
      /** The owner said this task may merge. */
      mergeOk: boolean;
      /** The green-main words the task waits with, or null when the main passes or the task repairs it. */
      mainWait: string | null;
    };

export interface MergeFacts {
  gate: GateReading;
  /** The repository the request is for. */
  repository: string;
  /** The branch of the run in this repository. */
  branch: string;
  /** The target's own tip reading says the head is behind it. */
  behind: boolean;
  /** A rebase was already sent for this head. */
  rebaseSent: boolean;
  target: MergeTarget;
}

type MergeDecision =
  | { kind: 'wait'; note: string }
  | { kind: 'rebase' }
  | { kind: 'person'; note: string }
  | { kind: 'merge'; head: string }
  | { kind: 'merged'; sha: string };

export const CLOSED_NOTE = 'its merge request was closed without a merge';

/** What a request that is still behind after a rebase asks of a person. */
export function stillBehind(branch: string): string {
  return `still behind ${branch} after a rebase; needs a person`;
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
  if (facts.behind || gate.mergeability === 'behind' || gate.mergeability === 'conflicting') {
    return facts.rebaseSent ? { kind: 'person', note: stillBehind(facts.branch) } : { kind: 'rebase' };
  }
  if (gate.failing.length > 0)
    return { kind: 'person', note: `checks failing: ${gate.failing.join(', ')}; needs a person` };
  if (gate.pending.length > 0)
    return { kind: 'person', note: `checks pending: ${gate.pending.join(', ')}; needs a person` };
  if (gate.mergeability === 'blocked') {
    return { kind: 'person', note: `reviews: ${gate.blockedBy ?? 'blocked'}; needs a person` };
  }
  const { target } = facts;
  if (target.kind === 'main') {
    if (target.mainWait) return { kind: 'wait', note: target.mainWait };
    if ((target.mode === 'ok' || target.manual) && !target.mergeOk) {
      return { kind: 'wait', note: 'waits for your OK to merge' };
    }
  }
  return { kind: 'merge', head: gate.head };
}
