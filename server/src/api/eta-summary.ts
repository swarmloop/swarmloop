import { Injectable } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import type { EtaTable, FinishedRunInput } from '../eta/eta.types';
import { stepNumbers } from '../eta/step-numbers';
import { EtaHistoryRepository } from '../history/eta-history.repository';
import { RunWaitLog } from '../history/run-wait.log';

/** How many finished runs of each kind the step numbers are read from. */
const RUNS_PER_KIND = 200;

type FinishedRuns = Awaited<ReturnType<EtaHistoryRepository['finishedRuns']>>;

function inputsOf(runs: FinishedRuns): FinishedRunInput[] {
  return runs.map((run) => ({
    createdAt: run.createdAt,
    lastFinishedAt: run.steps.reduce<string | null>(
      (latest, step) => (latest && latest > step.lastFinishedAt ? latest : step.lastFinishedAt),
      null,
    ),
    mergedAt: run.mergedAt,
    parentRunId: run.kind === 'subtask' ? String(run.id) : null,
    epicAt: run.kind === 'epic' ? run.createdAt : null,
    entries: run.steps.map((step) => ({ step: step.step, startedAt: step.enteredAt, finishedAt: step.lastFinishedAt })),
    waits: run.waits.map((wait) => ({ from: wait.startedAt, to: wait.endedAt })),
  }));
}

/**
 * The step numbers the estimates are read from, kept in memory. They are built from the finished runs on the first
 * read and again on the first read after a run finishes; reads run one after another.
 */
@Injectable()
export class EtaSummary implements OnModuleDestroy {
  private cached: EtaTable | undefined;
  private finishes = 0;
  private readonly unsubscribe: () => void;
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly history: EtaHistoryRepository,
    waitLog: RunWaitLog,
  ) {
    this.unsubscribe = waitLog.onFinished(() => {
      this.finishes += 1;
      this.cached = undefined;
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe();
  }

  table(): Promise<EtaTable> {
    const next = this.tail.then(() => this.read());
    this.tail = next.catch(() => undefined);
    return next;
  }

  private async read(): Promise<EtaTable> {
    if (this.cached) return this.cached;
    const seen = this.finishes;
    const table = stepNumbers(inputsOf(await this.history.finishedRuns(RUNS_PER_KIND)));
    if (seen === this.finishes) this.cached = table;
    return table;
  }
}
