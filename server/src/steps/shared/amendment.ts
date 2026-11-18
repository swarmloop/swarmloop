import { readPlanChat, type PlanRevision } from '../../contract/plan-chat';
import { parseSubtasks, SUBTASKS_KIND } from '../../contract/subtask';
import type { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import type { VisitRepository } from '../../history/visit.repository';
import { ARTIFACTS } from '../contract/artifacts';

/**
 * The plan revisions written after the latest implement visit that finished ok: what the next implement pass is asked
 * to add or change. A run that never implemented, and a plan that did not change since, give none.
 */
export async function amendmentOf(
  documents: DocumentRepository,
  visits: VisitRepository,
  run: Pick<RunEntity, 'id' | 'key'>,
): Promise<PlanRevision[]> {
  const implemented = (await visits.listStats(run.id)).filter(
    (stat) => stat.step === 'implement' && stat.status === 'done',
  );
  const finished = implemented.at(-1)?.finishedAt;
  if (!finished) return [];
  const chat = readPlanChat(await documents.latestBody(run.key, ARTIFACTS.planChat.kind));
  return chat.revisions.filter((revision) => revision.at > finished);
}

/**
 * True when the run implemented one plan: it has an implement visit and no tasks. Its plan is amended and may not
 * split, also when its settings let a run split. A subtask never takes this road: its planner is its parent's.
 */
export async function implementedWithoutTasks(
  documents: DocumentRepository,
  visits: VisitRepository,
  run: Pick<RunEntity, 'id' | 'key' | 'parentRunId'>,
): Promise<boolean> {
  if (run.parentRunId || !(await visits.hasAgentVisit(run.id, 'implement'))) return false;
  return parseSubtasks(await documents.latestBody(run.key, SUBTASKS_KIND)).length === 0;
}

/** True when the plan in front of plan-improve is an amendment: it changed after the latest implement visit began. */
export async function planAmended(
  documents: DocumentRepository,
  visits: VisitRepository,
  run: Pick<RunEntity, 'id' | 'key' | 'parentRunId'>,
): Promise<boolean> {
  if (!(await implementedWithoutTasks(documents, visits, run))) return false;
  const began = (await visits.listStats(run.id)).filter((stat) => stat.step === 'implement').at(-1)?.startedAt;
  const chat = readPlanChat(await documents.latestBody(run.key, ARTIFACTS.planChat.kind));
  return began !== undefined && chat.revisions.some((revision) => revision.at > began);
}
