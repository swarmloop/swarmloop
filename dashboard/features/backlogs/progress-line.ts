import type { BacklogView } from '@contract/backlog';

/** How far the active milestone is, like `M3 · 4/7`; empty when no milestone is active. */
export function progressLine(view: BacklogView): string {
  const active = view.milestones.find((milestone) => milestone.status === 'active');
  if (!active) {
    return '';
  }
  const own = view.requirements.filter((requirement) => requirement.milestone === active.number);
  const closed = own.filter((requirement) => requirement.status === 'closed').length;
  return `M${active.number} · ${closed}/${own.length}`;
}
