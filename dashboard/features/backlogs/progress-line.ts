import { milestoneWork } from '@contract/milestone-work';
import type { BacklogView } from '@contract/backlog';

/** How far the active milestone is, like `M3 · 4/7`: its settled tasks (merged or skipped) over all its tasks; empty when no milestone is active. */
export function progressLine(view: BacklogView): string {
  const active = view.milestones.find((milestone) => milestone.status === 'active');
  if (!active) {
    return '';
  }
  const { settled, total } = milestoneWork(view, active.number);
  return `M${active.number} · ${settled}/${total}`;
}
