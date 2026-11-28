import { randomUUID } from 'crypto';
import { HttpException, Injectable, Logger, Optional } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { Clock } from '../../../core/clock';
import { SwarmloopError } from '../../../core/swarmloop-error';
import { BacklogChatRepository } from '../../../history/backlog-chat.repository';
import type { BacklogRecord, BacklogTurnRecord } from '../../../history/backlog-writers';
import { BacklogRepository } from '../../../history/backlog.repository';
import { LiveHub } from '../../../live/live.hub';
import { BacklogScheduler } from '../backlog-scheduler';
import { PlannerTurnActions } from './planner-actions';
import { messageView, turnView } from './planner-views';
import { BacklogTurnRunner } from './turn-runner';
import { TurnTakes } from './turn-takes';
import { failedKeys, holdsBacklog, resumeTarget, waitsForTry } from './turn-hold';
import { waitOf } from './turn-wait';
import type { TurnOutcome } from './turn-wait';

/** The backlog has no failed turn for Resume to run again. */
export class NoFailedTurn extends SwarmloopError {}

/** What a person reads when a turn fails for a reason that is not theirs to fix. */
const UNEXPECTED = 'The planner could not finish this turn. The reason is in the server log.';

/** The longest a timer waits in one go; a usage limit is never longer than a week. */
const MAX_DELAY_MS = 2 ** 31 - 1;

/**
 * The planner of every backlog. It wakes on a person's message and on the end of the scheduler's events pass, runs one
 * turn per backlog at a time (what comes while a turn runs goes into that turn, and a wake starts one next turn only
 * for what the running turn did not take), and owns its running turns and timers: it waits for them when the module closes.
 */
@Injectable()
export class BacklogPlanner implements OnModuleDestroy {
  private readonly logger = new Logger(BacklogPlanner.name);
  /** The work of each backlog that has a turn running. */
  private readonly running = new Map<number, Promise<void>>();
  /** The backlogs that were woken while a turn ran or waited. */
  private readonly woken = new Set<number>();
  /** The timers of the turns that wait for a usage limit or a code host outage to end. */
  private readonly timers = new Map<number, NodeJS.Timeout>();
  /** The turn of each backlog whose timer fired while other work of the backlog ran; its loop runs it next. */
  private readonly due = new Map<number, { backlog: BacklogRecord; turnKey: string }>();
  private unsubscribe: (() => void) | null = null;
  private closed = false;

  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly chat: BacklogChatRepository,
    private readonly runner: BacklogTurnRunner,
    private readonly actions: PlannerTurnActions,
    private readonly scheduler: BacklogScheduler,
    private readonly clock: Clock,
    private readonly takes: TurnTakes,
    @Optional() private readonly live?: LiveHub,
  ) {}

  /** Starts the planner of the API server: it subscribes to the events pass and recovers the turns a stop left. A CLI process never starts it. */
  async start(): Promise<void> {
    this.unsubscribe = this.scheduler.afterEvents(() => this.wakeWaiting());
    await this.recover();
  }

  /** Stops the timers and the subscription, and waits for the turns that run. */
  async onModuleDestroy(): Promise<void> {
    this.closed = true;
    this.unsubscribe?.();
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.due.clear();
    await this.whenIdle();
  }

  /** Resolves when no turn of any backlog runs. A turn that waits for a usage limit or a code host is not running. */
  async whenIdle(): Promise<void> {
    while (this.running.size > 0) await Promise.allSettled([...this.running.values()]);
    await this.takes.idle();
  }

  /** A person's message: a turn takes what waits. A running turn takes it into itself; while one waits for a limit or a code host, one next turn follows it. */
  wake(backlogId: number): void {
    if (this.closed) return;
    // A running turn takes what came into itself; only what it does not take starts one next turn.
    if (!this.takes.take(backlogId)) this.woken.add(backlogId);
    if (!this.running.has(backlogId) && !this.timers.has(backlogId)) this.begin(backlogId, () => Promise.resolve());
  }

  /** Runs the backlog's last turn again under its key, with the items it took, when it failed; or an applied turn whose sending failed. */
  async resume(backlogName: string): Promise<void> {
    const backlog = await this.find(backlogName);
    const id = backlog.id as number;
    const failed = resumeTarget(await this.chat.turnsOf(id));
    if (!failed) throw new NoFailedTurn(`${backlogName} has no failed turn to resume`);
    if (this.running.has(id)) throw new SwarmloopError(`${backlogName}: the planner is working on a turn`);
    this.begin(id, () => this.execute(backlog, failed.turnKey));
  }

  /** On the end of each events pass: wakes a backlog whose last turn does not hold it, for messages and events no turn has taken and for those its failed turns hold. */
  private async wakeWaiting(): Promise<void> {
    try {
      const failed = (await this.chat.turnsByStatus(['failed'])).map((turn) => turn.turnKey);
      for (const id of await this.chat.backlogsWithWaitingWork(failed)) {
        if (!holdsBacklog(await this.chat.turnsOf(id))) this.wake(id);
      }
    } catch (error) {
      this.logger.warn(`planner pass failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** After a start: sends again what an applied turn recorded, runs a running turn again under its key, and sets the timer of a turn that waits for its next try. */
  private async recover(): Promise<void> {
    const backlogs = await this.backlogs.listBacklogs();
    for (const turn of await this.chat.turnsByStatus(['applied', 'running', 'waiting'])) {
      const backlog = backlogs.find((candidate) => candidate.id === turn.backlogId);
      if (!backlog) continue;
      if (waitsForTry(turn)) this.arm(backlog, turn.turnKey, turn.nextTryAt);
      else this.begin(turn.backlogId, () => this.runAgain(backlog, turn));
    }
  }

  /** A running turn's rows a dead process left open are ended, with their cost kept, before the turn launches again. */
  private async runAgain(backlog: BacklogRecord, turn: BacklogTurnRecord): Promise<void> {
    if (turn.status === 'running') await this.runner.closeLeftOpen(turn.turnKey);
    await this.execute(backlog, turn.turnKey);
  }

  /** Starts the work of a backlog, then the turns that were asked for meanwhile, one after the other. */
  private begin(backlogId: number, first: () => Promise<void>): void {
    const work = (async () => {
      try {
        await this.guarded(first);
        await this.runDue(backlogId);
        while (!this.closed && !this.timers.has(backlogId) && this.woken.delete(backlogId)) {
          await this.guarded(() => this.newTurn(backlogId));
          await this.runDue(backlogId);
        }
      } finally {
        this.running.delete(backlogId);
      }
    })();
    this.running.set(backlogId, work);
  }

  /** Runs the turn whose next try came during the work just done, once, while it still waits for it. */
  private async runDue(backlogId: number): Promise<void> {
    const entry = this.due.get(backlogId);
    this.due.delete(backlogId);
    if (entry && !this.closed) await this.guarded(() => this.executeWaiting(entry.backlog, entry.turnKey));
  }

  private async guarded(work: () => Promise<void>): Promise<void> {
    try {
      await work();
    } catch (error) {
      this.logger.warn(`planner turn failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** A turn that takes every waiting message and event, and those of the backlog's failed turns. Nothing waiting launches nothing. */
  private async newTurn(backlogId: number): Promise<void> {
    const failed = failedKeys(await this.chat.turnsOf(backlogId));
    const waiting = await this.chat.waitingItems(backlogId, failed);
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
    await this.chat.takeInto(backlogId, turnKey, failed);
    await this.execute(backlog, turnKey);
  }

  /** Runs a turn that exists: an applied one is only sent again; any other launches. Its end is written and shown; a usage limit or a code host outage ends in a wait. */
  private async execute(backlog: BacklogRecord, turnKey: string): Promise<void> {
    const turn = (await this.chat.findTurn(turnKey)) as BacklogTurnRecord;
    try {
      if (turn.status === 'applied') {
        // A next try that has come is spent: a new wait sets it again, a failure must not show it.
        await this.mark(turn, { reason: '', nextTryAt: null });
        const outcome = await this.resend(backlog, turnKey);
        if (outcome.status === 'waiting') await this.waitFor(backlog, turnKey, outcome);
      } else {
        await this.mark(turn, { status: 'running', reason: '', nextTryAt: null });
        await this.publishTurn(backlog, turnKey);
        const items = await this.chat.itemsOfTurn(turnKey);
        if (items.messages.length + items.events.length === 0) {
          await this.mark(turn, { status: 'done' });
        } else {
          await this.runTaking(backlog, turnKey);
        }
      }
    } catch (error) {
      await this.fail(backlog, turnKey, error);
    }
    await this.publish(backlog, turnKey);
  }

  /** Runs the turn with its take window open: what comes meanwhile is taken into it. The window closes before the turn waits, fails or ends. */
  private async runTaking(backlog: BacklogRecord, turnKey: string): Promise<void> {
    this.takes.open(backlog.id as number, turnKey, () => this.publishTurn(backlog, turnKey));
    try {
      const outcome = await this.runner.run(backlog.name, turnKey);
      await this.takes.close(turnKey);
      if (outcome.status === 'waiting') await this.waitFor(backlog, turnKey, outcome);
    } finally {
      await this.takes.close(turnKey);
    }
  }

  /** The timer's work: the turn runs only when it still waits for its next try, never after it was sent or done meanwhile. */
  private async executeWaiting(backlog: BacklogRecord, turnKey: string): Promise<void> {
    const turn = await this.chat.findTurn(turnKey);
    if (turn && waitsForTry(turn)) await this.execute(backlog, turnKey);
  }

  /** Sends again what an applied turn recorded. A code host outage is a wait; any other error is thrown. */
  private async resend(backlog: BacklogRecord, turnKey: string): Promise<TurnOutcome> {
    try {
      await this.actions.apply(backlog.name, turnKey, { say: '', actions: [] });
      return { status: 'done' };
    } catch (error) {
      const wait = waitOf(error);
      if (wait) return wait;
      throw error;
    }
  }

  /** The one waiting path of a usage limit and a code host outage: the turn shows its next try and runs again then. An applied turn keeps 'applied'. */
  private async waitFor(
    backlog: BacklogRecord,
    turnKey: string,
    outcome: Extract<TurnOutcome, { status: 'waiting' }>,
  ): Promise<void> {
    const turn = (await this.chat.findTurn(turnKey)) as BacklogTurnRecord;
    await this.mark(turn, {
      status: turn.status === 'applied' ? 'applied' : 'waiting',
      reason: outcome.reason,
      nextTryAt: outcome.resumesAt,
    });
    this.arm(backlog, turnKey, outcome.resumesAt);
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
      kind: 'failed',
      text: `This turn failed: ${reason}\n\nResume runs it again with the same messages and events.`,
      proposes: null,
      turn: turnKey,
      attachments: [],
      offers: [],
      createdAt: this.clock.iso(),
    });
  }

  /** Runs a turn again at its next try, through the clock, only while that turn still waits for it. */
  private arm(backlog: BacklogRecord, turnKey: string, nextTryAt: string | null): void {
    if (this.closed) return;
    const id = backlog.id as number;
    clearTimeout(this.timers.get(id));
    const wait = Math.min(MAX_DELAY_MS, Math.max(0, Date.parse(nextTryAt ?? '') - this.clock.now() || 0));
    const timer = setTimeout(() => {
      this.timers.delete(id);
      if (this.closed) return;
      // Other work of the backlog runs: its loop runs this turn right after that work.
      if (this.running.has(id)) this.due.set(id, { backlog, turnKey });
      else this.begin(id, () => this.executeWaiting(backlog, turnKey));
    }, wait);
    timer.unref();
    this.timers.set(id, timer);
  }

  private async mark(turn: BacklogTurnRecord, change: Partial<BacklogTurnRecord>): Promise<void> {
    const current = (await this.chat.findTurn(turn.turnKey)) ?? turn;
    await this.chat.saveTurn({ ...current, ...change });
  }

  /** Sends the planner's lines of the turn and then its status to the dashboard. */
  private async publish(backlog: BacklogRecord, turnKey: string): Promise<void> {
    const recent = await this.chat.lastMessages(backlog.id as number, 20);
    for (const message of recent.messages.filter((item) => item.turn === turnKey && item.author === 'planner')) {
      this.live?.backlog({ backlog: backlog.name, message: messageView(message) });
    }
    await this.publishTurn(backlog, turnKey);
  }

  /** Sends the turn's status to the dashboard. */
  private async publishTurn(backlog: BacklogRecord, turnKey: string): Promise<void> {
    const turn = await this.chat.findTurn(turnKey);
    if (turn) this.live?.backlog({ backlog: backlog.name, turn: turnView(turn) });
  }

  private async find(name: string): Promise<BacklogRecord> {
    const backlog = await this.backlogs.findBacklog(name);
    if (backlog === null) throw new SwarmloopError(`no backlog ${name}`);
    return backlog;
  }
}
