import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../core/clock';
import type { RunEntity } from '../history/entities';
import type { PlanChatEntry } from '../contract/plan-chat';
import { isSubtask } from '../contract/subtask';
import { PlanChatStore } from '../history/plan-chat.store';
import { RunRepository } from '../history/run.repository';
import { planReplyFor, type PlanReplyResult } from '../agent-result/definitions/plan-reply';
import { resultPromptFor } from '../agent-result/result-prompt';
import { planChatTakes } from '../steps/plan/plan.prompts';
import { PlanConversation } from '../steps/shared/plan-conversation';
import { replyEscalation } from '../steps/shared/reply-escalation';
import { StarterExchange } from '../steps/shared/starter-exchange';
import { hostRoute, isModelOutage, ModelHostUnavailable } from '../steps/shared/model-host-unavailable';
import { CommandService } from './command.service';
import { PlannerTurns } from './planner-turns';
import { StartGate } from './start-gate';
import { hasReply, openedFor } from './planner-question';
import { PERSON_RESUME } from './resume-sender';

/** What the reply asked the run to do once the turn ended. */
interface Act {
  command: 'resume' | 'replay';
  payload: Record<string, unknown>;
  /** The keys of the messages the turn took, and the key of the first: it names the command. */
  messages: string[];
  first: string;
}

/** What a stopped run's reply says besides its answer: nothing but a person's Resume starts it. */
const STAYS_STOPPED = 'The run stays stopped. Resume starts it.';

/**
 * The turn of a run's planner for the messages of a person when no step drives the run: it answers, and may resume the
 * run, replay it from a step with an instruction or escalate. The messages are always taken, except the ones a resume
 * leaves for the resumed run, which takes them before its next step.
 */
@Injectable()
export class PlannerOwnTurn {
  private readonly logger = new Logger(PlannerOwnTurn.name);
  private readonly tails = new Map<string, Promise<void>>();
  /** The outage keys of the takes in flight: a take under one of them returns at once. */
  private readonly outages = new Set<string>();

  constructor(
    private readonly turns: PlannerTurns,
    private readonly conversation: PlanConversation,
    private readonly chat: PlanChatStore,
    private readonly runs: RunRepository,
    private readonly commands: CommandService,
    private readonly clock: Clock,
    private readonly gate: StartGate,
  ) {}

  /**
   * Takes the messages of the run that wait, in one turn. Takes of one run go one after another and ask `busy` once
   * their turn comes, so a take that waited behind a reply's resume sees the run started and leaves the messages that
   * resume handed to the resumed run. With none pending it ends. A take with an `outage` key (`host-<message>-<retryAt>`)
   * runs only while the first pending message still waits for that next try, and once at a time per key.
   */
  async take(key: string, busy: () => Promise<boolean>, outage?: string): Promise<void> {
    if (outage && this.outages.has(outage)) return;
    if (outage) this.outages.add(outage);
    const before = this.tails.get(key) ?? Promise.resolve();
    const mine = before.then(async () => {
      if (outage && !(await this.waitsFor(key, outage))) return;
      if (!(await busy())) await this.takeNow(key);
    });
    const tail = mine.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    try {
      await mine;
    } finally {
      if (outage) this.outages.delete(outage);
    }
  }

  /** Whether the first pending message still waits for the model host at the next try this key names. */
  private async waitsFor(key: string, outage: string): Promise<boolean> {
    const first = (await this.chat.pending(key))[0];
    return !!first?.wait && `host-${first.key}-${first.wait.retryAt}` === outage;
  }

  private async takeNow(key: string): Promise<void> {
    const first = (await this.chat.pending(key))[0];
    if (!first) return;
    const act = await this.turns.exclusive(key, { id: first.key, at: first.at, text: first.text }, () =>
      this.turn(key),
    );
    // The turn ended before the command, so the resumed run's own planner pass can begin its turn.
    if (act) await this.send(key, act);
  }

  /** One visit of the planner for the pending messages and what the reply leaves: the chat lines, and the act to send. */
  private async turn(key: string): Promise<Act | null> {
    const messages = await this.chat.pending(key);
    const run = await this.runs.findRun(key);
    if (messages.length === 0 || !run) return null;
    const keys = messages.map((message) => message.key);
    const subtask = isSubtask(run);
    const shape = planReplyFor({ split: false, subtask, answerOnly: true, acts: true });
    const opened = openedFor(run, this.clock);
    let visit: Awaited<ReturnType<PlanConversation['visit']>>;
    try {
      visit = await this.conversation.visit(
        opened,
        (received) => planChatTakes(messages, resultPromptFor(shape, received), subtask),
        shape,
        hasReply,
        messages.map((message) => message.text),
        { by: 'person' },
        true,
        'answer-person',
      );
    } catch (error) {
      if (!isModelOutage(error)) {
        // Any other end settles the wait too, so no pass launches the same outage's reply again.
        await this.chat.wait(key, keys, null);
        throw error;
      }
      await this.hostDown(run, keys, error);
      return null;
    }
    if (!visit || 'refused' in visit) {
      this.logger.warn(`${key}: the planner took no message: ${visit ? visit.refused.message : 'no usable reply'}`);
      await this.chat.markTaken(key, keys);
      return null;
    }
    const reply = visit.value as PlanReplyResult;
    const act = this.actOf(reply, keys);
    await this.chat.appendEntry(key, {
      key: `reply-${opened.startedAt}`,
      role: 'planner',
      text: act ? reply.reply.trim() : await this.answerOnly(key, reply.reply),
      at: this.clock.iso(),
      state: 'taken',
    });
    const escalation = replyEscalation(reply.escalate, { key: keys[0] }, this.clock.iso());
    if (escalation) {
      await this.escalate(run, escalation, keys);
      return null;
    }
    // A resume leaves the messages for the resumed run, with no wait of the outage that came before; any other turn takes them.
    if (act?.command !== 'resume') await this.chat.markTaken(key, keys);
    else await this.chat.wait(key, keys, null);
    return act;
  }

  /**
   * The model host did not answer. On a run a person stopped, the messages stay pending with the wait and its next
   * try, and the run stays stopped. On any other run the run waits for the host, as a step does, and the messages
   * stay pending for the resumed run.
   */
  private async hostDown(run: RunEntity, keys: string[], error: ModelHostUnavailable): Promise<void> {
    if (await this.gate.stopped(run)) {
      await this.chat.wait(run.key, keys, {
        on: 'model-host',
        since: this.clock.iso(),
        message: `${error.host} did not answer: ${error.detail}`,
        retryAt: error.retryAt,
      });
      return;
    }
    await this.chat.wait(run.key, keys, null);
    const route = hostRoute(error) as Extract<ReturnType<typeof hostRoute>, { to: 'wait' }>;
    const fresh = (await this.runs.findRun(run.key)) ?? run;
    await this.runs.release(fresh, {
      status: 'waiting',
      reason: { code: error.code, message: route.reason, retryAt: route.retryAt },
      stepStartedAt: null,
    });
  }

  private actOf(reply: PlanReplyResult, messages: string[]): Act | null {
    const first = messages[0];
    if (reply.resume) return { command: 'resume', payload: { ...PERSON_RESUME }, messages, first };
    if (!reply.replay) return null;
    const { step, instruction } = reply.replay;
    return { command: 'replay', payload: { step, prompt: instruction, ...PERSON_RESUME }, messages, first };
  }

  /** The reply of a turn that changes nothing: on a run a person stopped it says that the run stays stopped. */
  private async answerOnly(key: string, reply: string): Promise<string> {
    const stopped = await this.gate.stopped({ key });
    return stopped ? `${reply.trim()}\n\n${STAYS_STOPPED}` : reply.trim();
  }

  /**
   * What the planner could not settle, left to whoever started the run. A run without a parent puts it to the person or
   * the backlog planner like a step's question. A subtask hands it up as its implement's hand-up, which its parent's planner finds.
   */
  private async escalate(run: RunEntity, escalation: PlanChatEntry, keys: string[]): Promise<void> {
    if (isSubtask(run)) {
      await new StarterExchange(this.chat, this.clock).escalateFor(run, 'implement', keys[0], [escalation.text]);
      await this.chat.markTaken(run.key, keys);
      return;
    }
    await this.chat.appendEntry(run.key, escalation);
    await this.chat.markTaken(run.key, keys);
    await this.turns.escalate(run, escalation);
  }

  /** Sends the reply's command for the person. A refused command is logged and written in the chat; its messages are taken. */
  private async send(key: string, act: Act): Promise<void> {
    try {
      await this.commands.submit(act.command, key, act.payload, { idempotencyKey: `${act.command}-${act.first}` });
    } catch (error) {
      const why = error instanceof Error ? error.message : String(error);
      this.logger.warn(`${key}: the planner's ${act.command} was refused: ${why}`);
      await this.chat.markTaken(key, act.messages);
      await this.chat.appendEntry(key, {
        key: `refused-${act.command}-${act.first}`,
        role: 'planner',
        text: `The ${act.command} was refused: ${why}`,
        at: this.clock.iso(),
        state: 'taken',
      });
    }
  }
}
