import { PLAN_CHAT_KIND, readPlanChat, type PlanRevision } from '../../contract/plan-chat';

/** How many lines of each kind a reviewer reads; the rest is counted. */
const SHOWN = 3;

/** Where the whole of a cut text is: the run's conversation holds every message and every revision. */
const WHOLE = 'the whole is in the conversation of the run';

/** The first line of a reason, with how many lines are left out and where the whole is. */
function firstLine(reason: string): string {
  const [first, ...rest] = reason.trim().split('\n');
  return rest.length > 0 ? `${first} (${rest.length} more lines cut; ${WHOLE})` : first;
}

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
    ...(rest > 0 ? [`  ${label}: and ${rest} more (${WHOLE})`] : []),
  ];
}

/** The revisions since the first plan, oldest first. Null when the plan never changed. */
export function planChanges(revisions: readonly PlanRevision[]): PlanChangesSection | null {
  const moved = revisions.filter((revision) => revision.version >= 2).sort((a, b) => a.version - b.version);
  if (moved.length === 0) return null;
  const body = moved.flatMap((revision) => [
    `Plan v${revision.version}: ${firstLine(revision.reason)}`,
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
