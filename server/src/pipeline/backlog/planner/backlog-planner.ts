import { randomUUID } from 'crypto';
import { HttpException, Injectable, Logger, Optional } from '@nestjs/common';
import type { OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Clock } from '../../../core/clock';
import { SwarmloopError } from '../../../core/swarmloop-error';
import { BacklogChatRepository } from '../../../history/backlog-chat.repository';
import type { BacklogRecord, BacklogTurnRecord } from '../../../history/backlog-writers';
import { BacklogRepository } from '../../../history/backlog.repository';
import { LiveHub } from '../../../live/live.hub';
import { BacklogScheduler } from '../backlog-scheduler';
import { PlannerTurnActions } from './planner-actions';
import { BacklogTurnRunner } from './turn-runner';

/** The backlog has no failed turn for Resume to run again. */
export class NoFailedTurn extends SwarmloopError {}

/** What a person reads when a turn fails for a reason that is not theirs to fix. */
const UNEXPECTED = 'The planner could not finish this turn. The reason is in the server log.';

/** The longest a timer waits in one go; a usage limit is never longer than a week. */
const MAX_DELAY_MS = 2 ** 31 - 1;

/**
 * The planner of every backlog. It wakes on a person's message and on the end of the scheduler's events pass, runs one
 * turn per backlog at a time (a wake during a turn starts one next turn that takes everything that came meanwhile),
 * and owns its running turns and timers: it waits for them when the module closes.
 */
@Injectable()
export class BacklogPlanner implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BacklogPlanner.name);
  /** The work of each backlog that has a turn running. */
  private readonly running = new Map<number, Promise<void>>();
  /** The backlogs that were woken while a turn ran or waited. */
  private readonly woken = new Set<number>();
  /** The timers of the turns that wait for a usage limit to end. */
  private readonly timers = new Map<number, NodeJS.Timeout>();
  private unsubscribe: (() => void) | null = null;
  private closed = false;

  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly chat: BacklogChatRepository,
    private readonly runner: BacklogTurnRunner,
    private readonly actions: PlannerTurnActions,
    private readonly scheduler: BacklogScheduler,
    private readonly clock: Clock,
    @Optional() private readonly live?: LiveHub,
  ) {}

  async onModuleInit(): Promise<void> {
    this.unsubscribe = this.scheduler.afterEvents(() => this.wakeWaiting());
    await this.recover();
  }

  /** Stops the timers and the subscription, and waits for the turns that run. */
  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await this.whenIdle();
  }

  /** Resolves when no turn of any backlog runs. A turn that waits for a usage limit is not running. */
  async whenIdle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()]);
  }

  /** A person's message: a turn takes what waits. During a turn, or while one waits for a limit, one next turn follows it. */
  wake(backlogId: number): void {
    if (this.closed) return;
    this.woken.add(backlogId);
    if (!this.running.has(backlogId) && !this.timers.has(backlogId)) this.begin(backlogId, () => Promise.resolve());
  }

  /** Runs the failed turn again under its key, with the items it took. */
  async resume(backlogName: string): Promise<void> {
    const backlog = await this.find(backlogName);
    const id = backlog.id as number;
    const turns = await this.chat.turnsByStatus(['failed', 'applied']);
    const failed = turns
      .filter((turn) => turn.backlogId === id && (turn.status === 'failed' || turn.reason !== ''))
      .pop();
    if (!failed) throw new NoFailedTurn(`${backlogName} has no failed turn to resume`);
    if (this.running.has(id)) throw new SwarmloopError(`${backlogName}: the planner is working on a turn`);
    this.begin(id, () => this.execute(backlog, failed.turnKey));
  }

  /** On the end of each events pass: the backlogs with a message or an event no turn has taken. A failed turn holds its backlog until Resume. */
  private async wakeWaiting(): Promise<void> {
    try {
      const ids = await this.chat.backlogsWithWaitingWork();
      if (ids.length === 0) return;
      const held = new Set((await this.chat.turnsByStatus(['failed', 'waiting'])).map((turn) => turn.backlogId));
      for (const id of ids) if (!held.has(id)) this.wake(id);
    } catch (error) {
      this.logger.warn(`planner pass failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** After a start: sends again what an applied turn recorded, runs a running turn again under its key, and sets the timer of a waiting one. */
  private async recover(): Promise<void> {
    const backlogs = await this.backlogs.listBacklogs();
    for (const turn of await this.chat.turnsByStatus(['applied', 'running', 'waiting'])) {
      const backlog = backlogs.find((candidate) => candidate.id === turn.backlogId);
      if (!backlog) continue;
      if (turn.status === 'waiting') this.arm(backlog, turn.turnKey, turn.nextTryAt);
      else this.begin(turn.backlogId, () => this.execute(backlog, turn.turnKey));
    }
  }

  /** Starts the work of a backlog, then the turns that were asked for meanwhile, one after the other. */
  private begin(backlogId: number, first: () => Promise<void>): void {
    const work = (async () => {
      try {
        await this.guarded(first);
        while (!this.closed && !this.timers.has(backlogId) && this.woken.delete(backlogId)) {
          await this.guarded(() => this.newTurn(backlogId));
        }
      } finally {
        this.running.delete(backlogId);
      }
    })();
    this.running.set(backlogId, work);
  }

  private async guarded(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.logger.warn(`planner turn failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** A turn that takes every waiting message and event. Nothing waiting launches nothing. */
  private async newTurn(backlogId: number): Promise<void> {
    const waiting = await this.chat.waitingItems(backlogId);
    if (waiting.messages.length + waiting.events.length === 0) return;
    const backlog = (await this.backlogs.listBacklogs()).find((candidate) => candidate.id === backlogId);
    if (!backlog) return;
    const turnKey = `turn-${backlogId}-${randomUUID()}`;
    await this.chat.saveTurn({
      backlogId,
      turnKey,
      status: 'running',
      reason: '',
      nextTryAt: null,
      createdAt: this.clock.iso(),
    });
    await this.chat.takeInto(backlogId, turnKey);
    await this.execute(backlog, turnKey);
  }

  /** Runs a turn that exists: an applied one is only sent again; any other launches. Its end is written and shown. */
  private async execute(backlog: BacklogRecord, turnKey: string): Promise<void> {
    const turn = (await this.chat.findTurn(turnKey)) as BacklogTurnRecord;
    try {
      if (turn.status === 'applied') {
        await this.actions.apply(backlog.name, turnKey, { say: '', actions: [] });
      } else {
        await this.mark(turn, { status: 'running', reason: '', nextTryAt: null });
        const items = await this.chat.itemsOfTurn(turnKey);
        if (items.messages.length + items.events.length === 0) {
          await this.mark(turn, { status: 'done' });
        } else {
          const outcome = await this.runner.run(backlog.name, turnKey);
          if (outcome.status === 'waiting') {
            await this.mark(turn, { status: 'waiting', reason: outcome.reason, nextTryAt: outcome.resumesAt });
            this.arm(backlog, turnKey, outcome.resumesAt);
          }
        }
      }
    } catch (error) {
      await this.fail(backlog, turnKey, error);
    }
    await this.publish(backlog, turnKey);
  }

  /** A failed turn keeps its items waiting and says why in the chat. An applied turn keeps its status: its actions are written and are never made twice. */
  private async fail(backlog: BacklogRecord, turnKey: string, error: unknown): Promise<void> {
    this.logger.warn(`turn ${turnKey} failed: ${error instanceof Error ? error.message : String(error)}`);
    const reason = error instanceof SwarmloopError || error instanceof HttpException ? error.message : UNEXPECTED;
    const turn = (await this.chat.findTurn(turnKey)) as BacklogTurnRecord;
    await this.mark(turn, { status: turn.status === 'applied' ? 'applied' : 'failed', reason });
    await this.backlogs.addMessage({
      backlogId: backlog.id as number,
      messageKey: `${turnKey}-failed-${this.clock.now().toString(36)}`,
      author: 'planner',
      text: `This turn failed: ${reason}\n\nResume runs it again with the same messages and events.`,
      proposes: false,
      turn: turnKey,
      createdAt: this.clock.iso(),
    });
  }

  /** Runs a waiting turn again at its next try, through the clock. */
  private arm(backlog: BacklogRecord, turnKey: string, nextTryAt: string | null): void {
    if (this.closed) return;
    const id = backlog.id as number;
    clearTimeout(this.timers.get(id));
    const wait = Math.min(MAX_DELAY_MS, Math.max(0, Date.parse(nextTryAt ?? '') - this.clock.now() || 0));
    const timer = setTimeout(() => {
      this.timers.delete(id);
      if (!this.closed && !this.running.has(id)) this.begin(id, () => this.execute(backlog, turnKey));
    }, wait);
    timer.unref();
    this.timers.set(id, timer);
  }

  private async mark(turn: BacklogTurnRecord, change: Partial<BacklogTurnRecord>): Promise<void> {
    const current = (await this.chat.findTurn(turn.turnKey)) ?? turn;
    await this.chat.saveTurn({ ...current, ...change });
  }

  /** Sends the turn's status and the planner's lines of it to the dashboard. */
  private async publish(backlog: BacklogRecord, turnKey: string): Promise<void> {
    const turn = await this.chat.findTurn(turnKey);
    if (!turn) return;
    const recent = await this.chat.lastMessages(backlog.id as number, 20);
    for (const message of recent.messages.filter((item) => item.turn === turnKey && item.author === 'planner')) {
      const { id, author, text, proposes, createdAt } = message;
      this.live?.backlog({ backlog: backlog.name, message: { id: id as number, author, text, proposes, createdAt } });
    }
    this.live?.backlog({
      backlog: backlog.name,
      turn: { status: turn.status, reason: turn.reason, nextTryAt: turn.nextTryAt },
    });
  }

  private async find(name: string): Promise<BacklogRecord> {
    const backlog = await this.backlogs.findBacklog(name);
    if (backlog === null) throw new SwarmloopError(`no backlog ${name}`);
    return backlog;
  }
}
