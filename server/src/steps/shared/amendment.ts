import { readPlanChat, type PlanRevision } from '../../contract/plan-chat';
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
