import { Injectable } from '@nestjs/common';
import type { FlowItem } from '../../contract/api';
import { BacklogRepository } from '../../history/backlog.repository';
import { CheckoutRepository } from '../../history/checkout.repository';
import { DocumentRepository } from '../../history/document.repository';
import type { DocumentEntity, RunEntity } from '../../history/entities';
import { latest } from '../../history/latest-document';
import { RunRepository } from '../../history/run.repository';
import { ARTIFACTS } from '../contract/artifacts';
import { OPEN_ITEM_KINDS, openItems } from './open-items';
import type { PassedOn } from './question-parts';

/** What the open items of a run say about its state. */
type HoldFacts = { needsAnswers: boolean; asksPlanner: boolean };

/**
 * Who has an open question of a run. A question of a backlog's run is with the backlog's planner until the planner passes
 * it on to the person; any other question is the person's at once.
 */
@Injectable()
export class QuestionHolds {
  constructor(
    private readonly documents: DocumentRepository,
    private readonly checkouts: CheckoutRepository,
    private readonly runs: RunRepository,
    private readonly backlogs: BacklogRepository,
  ) {}

  /** True when the run, or a run above it, is the run of a task of a backlog. */
  async ofBacklog(run: RunEntity): Promise<boolean> {
    for (let at: RunEntity | null = run; at; at = await this.parentOf(at)) {
      if (await this.backlogs.findTaskByRunKey(at.key)) return true;
    }
    return false;
  }

  /** The items with the holder of each question: the planner's while it has not passed it on, else the planner's line. */
  async mark(run: RunEntity, items: FlowItem[], documents: DocumentEntity[]): Promise<FlowItem[]> {
    const backlog = items.some((item) => item.kind === 'question') && (await this.ofBacklog(run));
    return markHolders(items, documents, backlog);
  }

  /** The facts of the latest documents and pastes, read as the run view and the stall watch read them. */
  async facts(run: RunEntity): Promise<HoldFacts> {
    const documents = await this.documents.latestDocuments([run.id], [...OPEN_ITEM_KINDS]);
    const asksPaste = run.currentStep === 'requirements' && documents.some(({ kind }) => kind === 'pending');
    const pastes = asksPaste ? await this.checkouts.listPastes(run.key) : [];
    const items = openItems(
      run,
      documents,
      pastes.map((paste) => paste.url),
    );
    return holdFacts(await this.mark(run, items, documents));
  }

  /** The open questions the backlog's planner holds on the run. */
  async held(run: RunEntity): Promise<FlowItem[]> {
    const documents = await this.documents.latestDocuments([run.id], [...OPEN_ITEM_KINDS]);
    const items = await this.mark(run, openItems(run, documents, []), documents);
    return items.filter((item) => item.holder === 'planner');
  }

  private async parentOf(run: RunEntity): Promise<RunEntity | null> {
    return typeof run.parentRunId === 'number' ? this.runs.findById(run.parentRunId) : null;
  }
}

/** The passed-on questions of a stored document; an unreadable body is none. */
export function readPassedOn(body: string | null): PassedOn[] {
  if (!body?.trim()) return [];
  try {
    return ARTIFACTS.passedOn.parse(body);
  } catch {
    return [];
  }
}

/** The items with the holder of each question: the planner's while it has not passed it on, else the planner's line. */
export function markHolders(items: FlowItem[], documents: DocumentEntity[], ofBacklog: boolean): FlowItem[] {
  const passed = readPassedOn(latest(documents, ARTIFACTS.passedOn.kind));
  return items.map((item) => {
    if (item.kind !== 'question') return item;
    const line = passed.find((entry) => entry.question === item.id)?.line;
    if (line !== undefined) return { ...item, passedOn: line };
    return ofBacklog && item.answer.trim() === '' ? { ...item, holder: 'planner' as const } : item;
  });
}

/** The facts the marked items give: a question is the person's unless the planner holds it. */
export function holdFacts(items: FlowItem[]): HoldFacts {
  const held = items.filter((item) => item.holder === 'planner').length;
  return { needsAnswers: items.length > held, asksPlanner: held > 0 };
}
