import { Injectable, Logger, Optional } from '@nestjs/common';
import type { OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, In, IsNull, Not } from 'typeorm';
import type { EntityManager } from 'typeorm';
import { etaPhase } from '../contract/eta';
import { Clock } from '../core/clock';
import { LiveHub } from '../live/live.hub';
import { RunEntity } from './run.entity';
import { deriveState } from './run-state';
import { RunWaitEntity } from './run-wait.entity';

/**
 * Keeps the stretches in which a run waited for a person or for a next try. It follows the live change notices,
 * reads the run's own columns and writes only `run_waits`; it never writes a run and sends no notice.
 */
@Injectable()
export class RunWaitLog implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(RunWaitLog.name);
  private readonly finished: ((key: string) => void)[] = [];
  private tail: Promise<void> = Promise.resolve();
  private stop: (() => void) | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly clock: Clock,
    @Optional() private readonly live?: LiveHub,
  ) {
    this.stop = this.live?.onChanged((key) => this.enqueue(() => this.observe(key))) ?? null;
  }

  /** Calls `listener` with the key of a run each time a change shows it ended; the result stops the calls. */
  onFinished(listener: (key: string) => void): () => void {
    this.finished.push(listener);
    return () => {
      const at = this.finished.indexOf(listener);
      if (at >= 0) this.finished.splice(at, 1);
    };
  }

  /** Resolves when every change seen so far is written. */
  settled(): Promise<void> {
    return this.tail;
  }

  /** Looks at every run that has not ended or still has an open stretch, so a wait that began while the server was down is still counted. */
  onApplicationBootstrap(): void {
    this.enqueue(async () => {
      const stale = await this.dataSource.getRepository(RunWaitEntity).find({
        select: { runId: true },
        where: { endedAt: IsNull() },
      });
      const open = await this.dataSource.getRepository(RunEntity).find({
        select: { key: true },
        where: [{ status: Not('done') }, { id: In(stale.map((wait) => wait.runId)) }],
      });
      for (const { key } of open) {
        await this.observe(key);
      }
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stop?.();
    this.stop = null;
    await this.tail;
  }

  /** The stretches of each run, oldest first. */
  async waitsOf(runIds: number[]): Promise<Map<number, RunWaitEntity[]>> {
    const byRun = new Map<number, RunWaitEntity[]>(runIds.map((id) => [id, []]));
    if (runIds.length === 0) return byRun;
    const rows = await this.dataSource
      .getRepository(RunWaitEntity)
      .find({ where: { runId: In(runIds) }, order: { startedAt: 'ASC', id: 'ASC' } });
    for (const row of rows) byRun.get(row.runId)?.push(row);
    return byRun;
  }

  private enqueue(work: () => Promise<void>): void {
    this.tail = this.tail.then(work).catch((error: unknown) => {
      this.logger.warn(`Wait log failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async observe(key: string): Promise<void> {
    const ended = await this.record(this.dataSource.manager, key);
    if (ended) {
      for (const listener of this.finished) listener(key);
    }
  }

  /** Brings the run's open stretch in line with its state. True when the run has ended. */
  private async record(manager: EntityManager, key: string): Promise<boolean> {
    const run = await manager.findOne(RunEntity, {
      select: { id: true, status: true, stateReason: true, mergeOutcome: true },
      where: { key },
    });
    if (!run) return false;
    const { state, reason } = deriveState(run);
    const phase = etaPhase(state, reason);
    const open = await manager.findOne(RunWaitEntity, { where: { runId: run.id, endedAt: IsNull() } });
    const waiting = phase === 'person' || phase === 'timed';
    if (open && waiting && open.kind === phase && open.code === (reason?.code ?? null)) return false;
    const at = new Date(this.clock.now()).toISOString();
    if (open) await manager.update(RunWaitEntity, { id: open.id }, { endedAt: at });
    if (waiting) {
      await manager.insert(RunWaitEntity, { runId: run.id, kind: phase, code: reason?.code ?? null, startedAt: at });
    }
    return phase === 'ended';
  }
}
