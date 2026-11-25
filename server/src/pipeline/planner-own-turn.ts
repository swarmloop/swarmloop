import { Injectable, Logger } from '@nestjs/common';
import { Clock } from '../core/clock';
import type { PlanChatEntry } from '../contract/plan-chat';
import { isSubtask } from '../contract/subtask';
import { PlanChatStore } from '../history/plan-chat.store';
import { RunRepository } from '../history/run.repository';
import { planReplyFor, type PlanReplyResult } from '../agent-result/definitions/plan-reply';
import { resultPromptFor } from '../agent-result/result-prompt';
import { planChatTakes } from '../steps/plan/plan.prompts';
import { PlanConversation } from '../steps/shared/plan-conversation';
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
   * resume handed to the resumed run. With none pending it ends.
   */
  async take(key: string, busy: () => Promise<boolean>): Promise<void> {
    const before = this.tails.get(key) ?? Promise.resolve();
    const mine = before.then(async () => {
      if (!(await busy())) await this.takeNow(key);
    });
    const tail = mine.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    await mine;
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
    const visit = await this.conversation.visit(
      opened,
      (received) => planChatTakes(messages, resultPromptFor(shape, received), subtask),
      shape,
      hasReply,
      messages.map((message) => message.text),
      { by: 'person' },
      true,
    );
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
    const decide = reply.escalate?.trim();
    if (decide) {
      const escalation = this.escalation(keys[0], decide);
      await this.chat.appendEntry(key, escalation);
      await this.chat.markTaken(key, keys);
      await this.turns.escalate(run, escalation);
      return null;
    }
    // A resume leaves the messages for the resumed run; any other turn takes them.
    if (act?.command !== 'resume') await this.chat.markTaken(key, keys);
    return act;
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

  /** What the planner could not settle, left to whoever started the run; it goes up the chain like a step's question. */
  private escalation(first: string, text: string): PlanChatEntry {
    return {
      key: `escalate-${first}`,
      role: 'planner',
      kind: 'escalation',
      text,
      at: this.clock.iso(),
      state: 'pending',
    };
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
