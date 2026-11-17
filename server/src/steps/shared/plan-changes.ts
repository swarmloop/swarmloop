import { PLAN_CHAT_KIND, readPlanChat, type PlanRevision } from '../../contract/plan-chat';

/** How many lines of each kind a reviewer reads; the rest is counted. */
const SHOWN = 3;

/** The `Plan changes` prompt section: why the plan moved and what each change added, changed and dropped. */
export interface PlanChangesSection {
  heading: string;
  body: string;
}

function lines(label: string, items: readonly string[]): string[] {
  if (items.length === 0) return [];
  const rest = items.length - SHOWN;
  return [
    ...items.slice(0, SHOWN).map((item) => `  ${label}: ${item}`),
    ...(rest > 0 ? [`  ${label}: and ${rest} more`] : []),
  ];
}

/** The revisions since the first plan, oldest first. Null when the plan never changed. */
export function planChanges(revisions: readonly PlanRevision[]): PlanChangesSection | null {
  const moved = revisions.filter((revision) => revision.version >= 2).sort((a, b) => a.version - b.version);
  if (moved.length === 0) return null;
  const body = moved.flatMap((revision) => [
    `Plan v${revision.version}: ${revision.reason.trim().split('\n')[0]}`,
    ...lines('added', revision.added),
    ...lines('changed', revision.changed),
    ...lines('dropped', revision.dropped),
  ]);
  return { heading: 'Plan changes', body: body.join('\n') };
}

/** The same from the stored documents of a run: the newest plan chat holds every revision. */
export function planChangesOf(documents: readonly { kind: string; body: string }[]): PlanChangesSection | null {
  const stored = documents.filter((document) => document.kind === PLAN_CHAT_KIND).at(-1);
  return planChanges(readPlanChat(stored?.body ?? null).revisions);
}
