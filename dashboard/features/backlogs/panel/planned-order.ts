import type { BacklogView } from '@contract/backlog';

type Milestone = BacklogView['milestones'][number];

/**
 * The milestones still to come: the queued ones in queue order (the chain that starts at the active milestone and follows
 * `queuedAfter`; a queued one the chain does not reach follows by number), then the proposed ones by number.
 */
export function plannedMilestones(view: BacklogView): Milestone[] {
  const byNumber = (a: Milestone, b: Milestone): number => a.number - b.number;
  const queued = view.milestones.filter((item) => item.status === 'queued').sort(byNumber);
  const ordered: Milestone[] = [];
  let behind = view.milestones.find((item) => item.status === 'active')?.number;
  for (;;) {
    const next = queued.find((item) => item.queuedAfter === behind && !ordered.includes(item));
    if (behind === undefined || !next) {
      break;
    }
    ordered.push(next);
    behind = next.number;
  }
  const rest = queued.filter((item) => !ordered.includes(item));
  const proposed = view.milestones.filter((item) => item.status === 'proposed').sort(byNumber);
  return [...ordered, ...rest, ...proposed];
}
