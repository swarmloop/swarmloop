import type { DocumentEntity, RunEntity } from '../../history/entities';
import type { DocumentRepository } from '../../history/document.repository';
import type { CommandRepository } from '../../history/command.repository';
import type { CheckoutRepository } from '../../history/checkout.repository';
import type { RunSummary } from '../../contract/api';
import { openItems, stateView } from './flow';

export type OwnState = Pick<RunSummary, 'state' | 'stateReason'>;

/** What the state of a run is read from: the latest documents of each run and the pastes of a run. */
export interface StateSources {
  documents: Pick<DocumentRepository, 'latestDocuments'>;
  checkouts: Pick<CheckoutRepository, 'listPastes'>;
  commands: Pick<CommandRepository, 'queuedRunIds'>;
}

/** The documents `stateView` and `openItems` read: the open questions and answers, the pending paste and the error. */
const FACT_KINDS = ['questions', 'answers', 'pending', 'error'];

/** The run as the run page shows it: a run the pipeline holds that is not done reads as running. */
function shownRun(run: RunEntity, claimed: (key: string) => boolean): RunEntity {
  return claimed(run.key) && run.status !== 'done' ? { ...run, status: 'running' } : run;
}

/** The latest document of each fact kind, by run id, for the runs whose state needs them: those waiting or blocked. */
async function factsOf(
  documents: StateSources['documents'],
  runs: RunEntity[],
  claimed: (key: string) => boolean,
): Promise<Map<number, DocumentEntity[]>> {
  const needing = runs.filter((run) => ['waiting', 'blocked'].includes(shownRun(run, claimed).status));
  const found = await documents.latestDocuments(
    needing.map((run) => run.id),
    FACT_KINDS,
  );
  const byRun = new Map<number, DocumentEntity[]>();
  for (const document of found) {
    byRun.set(document.runId, [...(byRun.get(document.runId) ?? []), document]);
  }
  return byRun;
}

/** The state of one run as the run page shows it. Of the pending commands it reads only whether one is about to start the run. */
async function ownState(
  checkouts: StateSources['checkouts'],
  run: RunEntity,
  claimed: (key: string) => boolean,
  docs: DocumentEntity[],
  queued: boolean,
): Promise<OwnState> {
  const shown = shownRun(run, claimed);
  // The paste urls only matter where a run asks for a paste: at requirements, with a pending one.
  const asksPaste = shown.currentStep === 'requirements' && docs.some((document) => document.kind === 'pending');
  const pastes = asksPaste ? await checkouts.listPastes(run.key) : [];
  const open = openItems(
    shown,
    docs,
    pastes.map((paste) => paste.url),
  );
  const view = stateView(shown, open, docs, { queued });
  return { state: view.state, stateReason: view.reason };
}

/** The state of each of the runs as the run page shows it, by run key. The list and the tasks of a run page read it the same way. */
export async function ownStates(
  { documents, checkouts, commands }: StateSources,
  runs: RunEntity[],
  claimed: (key: string) => boolean,
): Promise<Map<string, OwnState>> {
  const [facts, queued] = await Promise.all([
    factsOf(documents, runs, claimed),
    commands.queuedRunIds(runs.map((run) => run.id)),
  ]);
  const states = new Map<string, OwnState>();
  for (const run of runs) {
    states.set(run.key, await ownState(checkouts, run, claimed, facts.get(run.id) ?? [], queued.has(run.id)));
  }
  return states;
}
