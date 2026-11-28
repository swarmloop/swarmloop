import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { StateReason } from '../../contract/run-state';
import { RunRepository } from '../../history/run.repository';
import { startWaitColumns } from '../../history/run-state';
import { ContainerGate } from '../../sandbox/container-gate';

/** Where a start's wait is stored when its owner is not a run: a backlog planner's turn keeps it on its own row. */
type WaitStore = (wait: StateReason | null) => Promise<void>;

/**
 * The one writer of what an agent start waits for before its first output. It reads the gate when a write runs, on
 * one queue, so the last write is always the current wait. A run keeps it with its state, an owner that is not a run
 * through the store it gives. A key is written only while it has a stored wait or one now, so a start that never waits
 * writes nothing.
 */
@Injectable()
export class StartWaits implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StartWaits.name);
  /** One entry per start key: the owner's store (none for a run) and whether a wait was written for it. */
  private readonly entries = new Map<string, { store?: WaitStore; written: boolean }>();
  private tail: Promise<void> = Promise.resolve();
  private stops: (() => void)[] = [];

  constructor(
    private readonly gate: ContainerGate,
    private readonly runs: RunRepository,
  ) {}

  /**
   * The pause starts or ends, or a place comes back: what each start that waits waits for changes with it. Every run
   * with an agent start in the gate is written again, besides the ones that already have a written wait. A key that
   * is registered and has not waited is left alone, so no rewrite drops its store before its start ends.
   */
  onModuleInit(): void {
    const rewrite = (): void => {
      const written = [...this.entries].filter(([, entry]) => entry.written).map(([key]) => key);
      for (const key of new Set([...written, ...this.gate.waitingKeys()])) {
        void this.changed(key);
      }
    };
    this.stops = [this.gate.onChange(rewrite), this.gate.onPlaces(rewrite)];
  }

  /**
   * Keeps the owner's store of the start of `key` (none for a run) before its first write is queued. A registered
   * store is never replaced; the entry goes when the start ends.
   */
  register(key: string, store?: WaitStore): void {
    if (!this.entries.has(key)) {
      this.entries.set(key, { store, written: false });
    }
  }

  /** Queues a write of what the agent starts of `key` wait for now. Resolves when it is written. */
  changed(key: string): Promise<void> {
    this.tail = this.tail.then(() => this.write(key));
    return this.tail;
  }

  /** Resolves when every write queued so far is done. */
  async settled(): Promise<void> {
    let seen: Promise<void>;
    do {
      seen = this.tail;
      await seen;
    } while (seen !== this.tail);
  }

  async onModuleDestroy(): Promise<void> {
    this.stops.forEach((stop) => stop());
    this.stops = [];
    await this.settled();
  }

  private async write(key: string): Promise<void> {
    const wait = this.gate.startWait(key);
    const entry = this.entries.get(key);
    if (!wait && !entry?.written) {
      // The start ends here: nothing was written for it, or its wait is cleared below.
      this.entries.delete(key);
      return;
    }
    const target = entry ?? { written: false };
    try {
      await (target.store ? target.store(wait) : this.onRun(key, wait));
      if (wait) {
        target.written = true;
        this.entries.set(key, target);
      } else {
        this.entries.delete(key);
      }
    } catch (error) {
      this.logger.warn(
        `Start wait of ${key} was not stored: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async onRun(key: string, wait: StateReason | null): Promise<void> {
    const run = await this.runs.findRun(key);
    if (run?.status === 'running') {
      await this.runs.recordStartWait(run, startWaitColumns(wait));
    }
  }
}
