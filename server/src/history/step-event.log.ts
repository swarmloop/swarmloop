import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, In, MoreThan, Repository } from 'typeorm';
import { AppConfig } from '../config/env';
import type { StepEvent, StepEventDraft, StepEventKind, StepEventPage } from '../contract/step-events';
import { Clock } from '../core/clock';
import { redact } from '../config/redact';
import { LiveHub } from '../live/live.hub';
import { RunEntity, StepEventEntity } from './entities';
import { transaction } from './transaction';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** Every string of a value, masked. The JSON is not masked as text: a pattern that runs to the end of a line would cut its quotes. */
function redactStrings(value: unknown): unknown {
  if (typeof value === 'string') {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactStrings(item));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStrings(item)]));
  }
  return value;
}

function toEvent(row: StepEventEntity): StepEvent {
  return {
    ...(JSON.parse(row.payload) as object),
    runId: row.runId,
    attemptId: row.attemptId,
    step: row.step,
    seq: row.seq,
    kind: row.kind,
    occurredAt: row.occurredAt,
  } as StepEvent;
}

/** The durable events of the steps of a run. */
@Injectable()
export class StepEventLog {
  constructor(
    private readonly clock: Clock,
    private readonly config: AppConfig,
    @InjectRepository(StepEventEntity) private readonly events: Repository<StepEventEntity>,
    @InjectRepository(RunEntity) private readonly runs: Repository<RunEntity>,
    @Optional() private readonly live?: LiveHub,
  ) {}

  /**
   * Stores events. The log gives each its `seq` in the transaction of the insert: the run's highest `seq` plus one,
   * in the order the events are given, so every event is kept and `seq` follows the order of recording.
   */
  async append(events: StepEventDraft[]): Promise<void> {
    if (events.length === 0) {
      return;
    }
    const recordedAt = this.clock.iso();
    const last = await transaction(this.events.manager.connection, async (manager) => {
      const next = new Map<number, number>();
      let stored = 0;
      for (const { runId, attemptId, step, kind, occurredAt, ...rest } of events) {
        if (!next.has(runId)) {
          next.set(runId, ((await manager.maximum(StepEventEntity, 'seq', { runId })) ?? 0) + 1);
        }
        stored = next.get(runId) ?? 1;
        next.set(runId, stored + 1);
        const payload = JSON.stringify(redactStrings(rest));
        await manager.insert(
          StepEventEntity,
          manager.create(StepEventEntity, {
            runId,
            attemptId,
            step,
            seq: stored,
            kind,
            payload,
            occurredAt,
            recordedAt,
          }),
        );
      }
      return stored;
    });
    await this.notify(events[events.length - 1], last);
  }

  /** Tells the live hub which event came last, with the `seq` it was stored under. The run key is found from the run id; a run without a row is not announced. */
  private async notify(last: StepEventDraft, seq: number): Promise<void> {
    if (!this.live) {
      return;
    }
    try {
      const run = await this.runs.findOne({ where: { id: last.runId } });
      if (run) {
        this.live.appended({ key: run.key, step: last.step, seq });
      }
    } catch {
      // The events are stored; a failed lookup only skips the push.
    }
  }

  /** The last `seq` of a run, or 0 when it has no events. */
  async lastSeq(runId: number): Promise<number> {
    const last = await this.events.findOne({ where: { runId }, order: { seq: 'DESC' } });
    return last?.seq ?? 0;
  }

  /** The last event an attempt recorded, or null when it recorded none. */
  async lastOfAttempt(runId: number, attemptId: string): Promise<StepEvent | null> {
    const last = await this.events.findOne({ where: { runId, attemptId }, order: { seq: 'DESC' } });
    return last ? toEvent(last) : null;
  }

  /** The newest end of an attempt of `step`, finished or interrupted, or null when none ended. */
  async lastEnd(
    runId: number,
    step: string,
  ): Promise<Extract<StepEvent, { kind: 'attempt.finished' | 'attempt.interrupted' }> | null> {
    const kind = In<StepEventKind>(['attempt.finished', 'attempt.interrupted']);
    const last = await this.events.findOne({ where: { runId, step, kind }, order: { seq: 'DESC' } });
    return last ? (toEvent(last) as Extract<StepEvent, { kind: 'attempt.finished' | 'attempt.interrupted' }>) : null;
  }

  /** Events after `after`, oldest first. `next` is set when the page is full. */
  async page(runId: number, query: { step?: string; after?: number; limit?: number }): Promise<StepEventPage> {
    const limit = Math.min(Math.max(query.limit ?? DEFAULT_LIMIT, 1), MAX_LIMIT);
    const where: FindOptionsWhere<StepEventEntity> = { runId, seq: MoreThan(query.after ?? 0) };
    if (query.step !== undefined) {
      where.step = query.step;
    }
    const rows = await this.events.find({ where, order: { seq: 'ASC' }, take: limit });
    const events = rows.map(toEvent);
    return { events, next: events.length === limit ? events[events.length - 1].seq : null };
  }

  private async ofKind<K extends StepEventKind>(runId: number, kind: K): Promise<Extract<StepEvent, { kind: K }>[]> {
    const rows = await this.events.find({ where: { runId, kind }, order: { seq: 'ASC' } });
    return rows.map(toEvent) as Extract<StepEvent, { kind: K }>[];
  }

  /** Whether `step` has already recorded that it took this handoff. */
  async hasReceived(runId: number, step: string, handoffId: number): Promise<boolean> {
    const received = await this.ofKind(runId, 'handoff.received');
    return received.some((event) => event.step === step && event.handoffId === handoffId);
  }

  /** The ids of the issues `step` opened that no `issue.resolved` has closed. */
  async openIssues(runId: number, step: string): Promise<string[]> {
    const resolved = new Set((await this.ofKind(runId, 'issue.resolved')).map((event) => event.issueId));
    const opened = (await this.ofKind(runId, 'issue.opened')).filter((event) => event.step === step);
    return [...new Set(opened.map((event) => event.issueId))].filter((id) => !resolved.has(id));
  }
}
