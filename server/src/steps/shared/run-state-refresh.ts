import { Injectable, Logger, Optional } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { CheckoutRepository } from '../../history/checkout.repository';
import { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import { RunFactsRepository } from '../../history/run-facts.repository';
import { RunRepository } from '../../history/run.repository';
import { factColumns, isReturned } from '../../history/run-state';
import { LiveHub } from '../../live/live.hub';
import { OPEN_ITEM_KINDS, openItems } from './open-items';

/** Statuses whose writers store the whole state: the facts of the documents do not change it. */
const WRITTEN_WHOLE = ['running', 'done', 'failed'];

/**
 * Keeps the `state` and `state_reason` columns of a run right when a fact the row does not hold changes: its open
 * questions and a return. It follows the live change notices on one queue and writes only
 * those two columns, through `RunFactsRepository`.
 */
@Injectable()
export class RunStateRefresh implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RunStateRefresh.name);
  private readonly waiting = new Set<string>();
  private tail: Promise<void> = Promise.resolve();
  private stop: (() => void) | null;

  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly checkouts: CheckoutRepository,
    private readonly facts: RunFactsRepository,
    @Optional() live?: LiveHub,
  ) {
    this.stop =
      live?.onChanged((key) => {
        if (this.waiting.has(key)) return;
        this.waiting.add(key);
        void this.enqueue(async () => {
          this.waiting.delete(key);
          await this.refresh(key);
        });
      }) ?? null;
  }

  /** One pass over every run, so a process serves only after the columns are right. */
  async onApplicationBootstrap(): Promise<void> {
    await this.enqueue(async () => {
      for (const { key } of await this.runs.listRuns()) await this.refresh(key);
    });
  }

  /** Resolves when every notice seen so far is written. */
  async settled(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = this.tail;
      await seen;
    } while (seen !== this.tail);
  }

  async onModuleDestroy(): Promise<void> {
    this.stop?.();
    this.stop = null;
    await this.settled();
  }

  private enqueue(work: () => Promise<void>): Promise<void> {
    this.tail = this.tail.then(work).catch((error: unknown) => {
      this.logger.warn(`State refresh failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    return this.tail;
  }

  private async refresh(key: string): Promise<void> {
    const run = await this.runs.findRun(key);
    if (!run || (run.state !== null && WRITTEN_WHOLE.includes(run.status))) return;
    await this.facts.recordFacts(run, factColumns(run, await this.read(run)));
  }

  /** The facts of the latest documents and pastes, read as the run view and the stall watch read them. */
  private async read(run: RunEntity): Promise<Parameters<typeof factColumns>[1]> {
    const documents = await this.documents.latestDocuments([run.id], [...OPEN_ITEM_KINDS]);
    const asksPaste = run.currentStep === 'requirements' && documents.some(({ kind }) => kind === 'pending');
    const pastes = asksPaste ? await this.checkouts.listPastes(run.key) : [];
    return {
      needsAnswers:
        openItems(
          run,
          documents,
          pastes.map((paste) => paste.url),
        ).length > 0,
      returned: isReturned(run),
    };
  }
}
