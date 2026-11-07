import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { FindOptionsWhere, MoreThan, Repository } from 'typeorm';
import { AppConfig } from '../config/env';
import type { StepEvent, StepEventKind, StepEventPage } from '../contract/step-events';
import { Clock } from '../core/clock';
import { redact } from '../core/redact';
import { LiveHub } from '../live/live.hub';
import { RunEntity, StepEventEntity } from './entities';

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

/** Every string of a value, masked. The JSON is not masked as text: a pattern that runs to the end of a line would cut its quotes. */
function redactStrings(value: unknown, env: object): unknown {
  if (typeof value === 'string') {
    return redact(value, env);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactStrings(item, env));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactStrings(item, env)]));
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

  async append(events: StepEvent[]): Promise<void> {
    const recordedAt = this.clock.iso();
    await this.events.insert(
      events.map(({ runId, attemptId, step, seq, kind, occurredAt, ...rest }) =>
        this.events.create({
          runId,
          attemptId,
          step,
          seq,
          kind,
          payload: JSON.stringify(redactStrings(rest, this.config.env)),
          occurredAt,
          recordedAt,
        }),
      ),
    );
    await this.notify(events[events.length - 1]);
  }

  /** Tells the live hub which event came last. The run key is found from the run id; a run without a row is not announced. */
  private async notify(last: StepEvent | undefined): Promise<void> {
    if (!last || !this.live) {
      return;
    }
    try {
      const run = await this.runs.findOne({ where: { id: last.runId } });
      if (run) {
        this.live.appended({ key: run.key, step: last.step, seq: last.seq });
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
