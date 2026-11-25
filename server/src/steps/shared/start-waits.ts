import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { StateReason } from '../../contract/run-state';
import { RunFactsRepository } from '../../history/run-facts.repository';
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
  /** The keys that have a stored wait, with the store each one is written to. */
  private readonly stored = new Map<string, WaitStore | undefined>();
  private tail: Promise<void> = Promise.resolve();
  private stops: (() => void)[] = [];

  constructor(
    private readonly gate: ContainerGate,
    private readonly runs: RunRepository,
    private readonly facts: RunFactsRepository,
  ) {}

  /**
   * The pause starts or ends, or a place comes back: what each start that waits waits for changes with it. Every run
   * with an agent start in the gate is written again, besides the ones that already have a stored wait.
   */
  onModuleInit(): void {
    const rewrite = (): void => {
      for (const key of new Set([...this.stored.keys(), ...this.gate.waitingKeys()])) {
        void this.changed(key, this.stored.get(key));
      }
    };
    this.stops = [this.gate.onChange(rewrite), this.gate.onPlaces(rewrite)];
  }

  /** Queues a write of what the agent starts of `key` wait for now. Resolves when it is written. */
  changed(key: string, store?: WaitStore): Promise<void> {
    this.tail = this.tail.then(() => this.write(key, store));
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

  private async write(key: string, store?: WaitStore): Promise<void> {
    const wait = this.gate.startWait(key);
    if (!wait && !this.stored.has(key)) {
      return;
    }
    try {
      await (store ? store(wait) : this.onRun(key, wait));
      if (wait) {
        this.stored.set(key, store);
      } else {
        this.stored.delete(key);
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
      await this.facts.recordStartWait(run, startWaitColumns(wait));
    }
  }
}
