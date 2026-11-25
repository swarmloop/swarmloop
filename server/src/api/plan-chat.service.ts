import { BadRequestException, ConflictException, Injectable, Logger, Optional } from '@nestjs/common';
import { Clock } from '../core/clock';
import type { CommandReceipt } from '../contract/command';
import type { FlowView } from '../contract/api';
import type { AttachmentRef } from '../contract/attachments';
import type { PlanChatEntry } from '../contract/plan-chat';
import { AttachmentStore } from '../history/attachment-store';
import { PlanChatStore } from '../history/plan-chat.store';
import { RunRepository } from '../history/run.repository';
import { CommandService } from '../pipeline/command.service';
import { PipelineService } from '../pipeline/pipeline.service';
import { PlannerTurns } from '../pipeline/planner-turns';
import { messageTurn, startsRun, waitingItems } from '../pipeline/plan-chat-route';
import { RunCommandsService } from './run-commands.service';
import { requireRun, RunQueriesService } from './run-queries.service';

/** What a message of a person is stored as: its text, the login that sent it and the files it came with. */
interface MessagePayload extends Record<string, unknown> {
  message: string;
  author?: string;
  attachments?: AttachmentRef[];
}

/** A person's message to the planner of a run: where it goes is decided by the run's place. */
@Injectable()
export class PlanChatService {
  constructor(
    private readonly runs: RunRepository,
    private readonly queries: RunQueriesService,
    private readonly commands: CommandService,
    private readonly store: PlanChatStore,
    private readonly turns: PlannerTurns,
    private readonly files: AttachmentStore,
    private readonly clock: Clock,
    @Optional() private readonly pipeline?: PipelineService,
    @Optional() private readonly runCommands?: RunCommandsService,
  ) {}

  private readonly logger = new Logger(PlanChatService.name);

  /** Checks the message against the run, then sends it as the command for its place: the answer while a question waits. */
  async send(
    key: string,
    message: string | undefined,
    author: string | null,
    idempotencyKey?: string,
    attachments?: string[],
  ): Promise<FlowView & CommandReceipt> {
    return this.route(key, message, author, true, idempotencyKey, attachments);
  }

  /** A message for the run's planner, whatever the run's open items: it is never the answer to a question. */
  async sendToPlanner(
    key: string,
    message: string | undefined,
    author: string | null,
    idempotencyKey?: string,
  ): Promise<FlowView & CommandReceipt> {
    return this.route(key, message, author, false, idempotencyKey);
  }

  private async route(
    key: string,
    message: string | undefined,
    author: string | null,
    mayAnswer: boolean,
    idempotencyKey?: string,
    attachments?: string[],
  ): Promise<FlowView & CommandReceipt> {
    const text = message?.trim();
    if (!text) {
      throw new BadRequestException('message is missing');
    }
    const run = await requireRun(this.runs, key);
    const view = await this.queries.flow(key);
    const turn = messageTurn(run, {
      state: view.state,
      parentKey: view.parentKey,
      openItems: waitingItems(view.items),
    });
    if (turn === 'to-parent' && view.parentKey) {
      return this.route(view.parentKey, `About ${run.taskId}: ${text}`, author, mayAnswer, idempotencyKey, attachments);
    }
    if (turn === 'follow-up' || turn === 'to-parent') {
      const ended = view.state === 'merged' || view.state === 'closed' ? view.state : 'removed';
      throw new ConflictException(`${key} is ${ended}: start a follow-up run`);
    }
    const refs = await this.files.claim(key, attachments);
    const payload: MessagePayload = {
      message: text,
      ...(author ? { author } : {}),
      ...(refs.length > 0 ? { attachments: refs } : {}),
    };
    const options = { idempotencyKey: idempotencyKey?.trim() || undefined, actor: author };
    if (turn === 'answer' && mayAnswer) {
      const sent = await this.commands.submit<FlowView>('answer', key, payload, options);
      await this.store.appendEntry(key, this.entry(sent.receipt.commandId, payload, 'taken'));
      return { ...sent.value, ...sent.receipt };
    }
    const sent = await this.commands.submit<FlowView>('plan-chat', key, payload, options);
    return { ...sent.value, ...sent.receipt };
  }

  /** The `plan-chat` command: stores the message as pending and offers it to the planner's turns. */
  async record(key: string, payload: Record<string, unknown>, commandId: string): Promise<FlowView> {
    const entry = this.entry(commandId, payload as MessagePayload, 'pending');
    await this.store.appendEntry(key, entry);
    this.turns.offer(key, { id: entry.key, at: entry.at, text: entry.text });
    const view = await this.queries.flow(key);
    const run = await this.runs.findRun(key);
    const turn =
      run && messageTurn(run, { state: view.state, parentKey: view.parentKey, openItems: waitingItems(view.items) });
    if (turn && startsRun(turn, view.state)) {
      await this.reopen(key, view.state);
    }
    return view;
  }

  /**
   * A done run takes the message in a pass of its own. A stopped, failed or blocked run does what Resume does, and the
   * driver takes the message before the resumed step. When Resume is refused the message stays pending and the run as it is.
   */
  private async reopen(key: string, state: string): Promise<void> {
    if (state === 'done') {
      this.pipeline?.amendDone(key);
      return;
    }
    try {
      await this.runCommands?.resume(key);
    } catch (error) {
      this.logger.warn(
        `${key}: Resume was refused, the message waits: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private entry(commandId: string, payload: MessagePayload, state: PlanChatEntry['state']): PlanChatEntry {
    return {
      key: `message-${commandId}`,
      role: 'person',
      ...(payload.author ? { author: payload.author } : {}),
      text: payload.message,
      ...(payload.attachments ? { attachments: payload.attachments } : {}),
      at: this.clock.iso(),
      state,
    };
  }
}
