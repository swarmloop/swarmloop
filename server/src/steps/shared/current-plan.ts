import type { PlanFields } from '../../integrations/requirements-source/requirements-record';
import type { DocumentRepository } from '../../history/document.repository';
import type { SplitFields } from '../../agent-result/definitions/split-fields';
import { ARTIFACTS } from '../contract/artifacts';
import { planItemsFromTasks } from '../plan/plan-tasks';
import { planFields, readPlan } from '../plan/plan-record';

/** The checklist a result holds: its plan, or the items of its tasks. Empty when the result keeps the plan before it. */
function itemsOf(result: Pick<SplitFields, 'tasks'> & { plan: string[] }): string[] {
  return result.plan.length > 0 ? result.plan : planItemsFromTasks(result.tasks);
}

/**
 * The plan of a run: the checklist of the newest plan, plan-improve or implement result that holds one, and the name, overview and
 * decision of the plan in the requirements record. A run without results reads the plan in the requirements record.
 */
export async function currentPlan(documents: DocumentRepository, key: string): Promise<PlanFields | null> {
  const stored = readPlan(await documents.latestBody(key, ARTIFACTS.requirements.kind));
  const results = [
    {
      doc: await documents.latestDocument(key, ARTIFACTS.planImproveResult.kind),
      artifact: ARTIFACTS.planImproveResult,
    },
    { doc: await documents.latestDocument(key, ARTIFACTS.planResult.kind), artifact: ARTIFACTS.planResult },
  ]
    .flatMap(({ doc, artifact }) => (doc ? [{ id: doc.id, items: itemsOf(artifact.parse(doc.body)) }] : []))
    .concat(await correctedByImplement(documents, key))
    .sort((a, b) => b.id - a.id);
  const items = results.find((result) => result.items.length > 0)?.items;
  return items ? { ...(stored ?? planFields([])), items } : stored;
}

/** The corrected checklists the implement steps sent, newest first with the others; a result without one is skipped. */
async function correctedByImplement(
  documents: DocumentRepository,
  key: string,
): Promise<{ id: number; items: string[] }[]> {
  const found = [
    {
      doc: await documents.latestDocument(key, ARTIFACTS.implementationResult.kind),
      artifact: ARTIFACTS.implementationResult,
    },
    {
      doc: await documents.latestDocument(key, ARTIFACTS.implementationImproveResult.kind),
      artifact: ARTIFACTS.implementationImproveResult,
    },
  ];
  return found.flatMap(({ doc, artifact }) =>
    doc ? [{ id: doc.id, items: artifact.parse(doc.body).plan ?? [] }] : [],
  );
}
