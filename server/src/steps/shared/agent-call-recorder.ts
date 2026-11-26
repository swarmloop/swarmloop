import { Injectable, Logger } from '@nestjs/common';
import type { AgentRunResult } from '../../agent/agent-result';
import type { PricedRequest } from '../../agent/request-usage';
import type { ChatUsage } from '../../agent/since-recorded';
import { NO_USAGE } from '../../agent/since-recorded';
import { Clock } from '../../core/clock';
import type { AgentCallRow, CallStart, OpenScope, RequestUsage, Tie } from '../../history/agent-call';
import { AgentCallRepository } from '../../history/agent-call.repository';
import type { AgentLaunchRequest, PingCall } from './agent-launch-request';
import { CallContexts } from './call-context';
import type { CallContext } from './call-context';
import { endOf } from './call-end';
import type { CallOutcome } from './call-end';

/** What the launcher says of a launch that the request does not carry. */
export interface CallOpening {
  /** The chat the launch resumes, or null for a new chat. */
  chatId: string | null;
  /** The row of the launch this one takes over from, after a provider limit. */
  replacesId?: number;
  /** The launch is a follow-up to an answer in the chat. */
  followUp?: boolean;
}

/** How a launch relates to the one before it in the same call: a follow-up to its answer, or the takeover of a limited one. */
export type CallLink = Omit<CallOpening, 'chatId'>;

/** What is known of the owner and the chat before a launch: what they spent, and what the chat last reported. */
interface SpendBefore {
  spentUsd: number;
  tokensInRun: number;
  chatSpentUsd: number;
  prior: ChatUsage;
}

const MINUTE_MS = 60_000;

/** The usage a request adds on top of what the same message id already counted. */
function difference(next: PricedRequest, last: PricedRequest | undefined): RequestUsage {
  return {
    model: next.model,
    input: next.input - (last?.input ?? 0),
    cacheRead: next.cacheRead - (last?.cacheRead ?? 0),
    cacheWrite: next.cacheWrite - (last?.cacheWrite ?? 0),
    output: next.output - (last?.output ?? 0),
    usd: next.usd - (last?.usd ?? 0),
    price: Object.fromEntries<number>(
      Object.entries(next.price ?? {}).filter((entry): entry is [string, number] => entry[1] !== null),
    ),
  };
}

/**
 * The row of one launch, and the rows of the helpers it starts. Each model request is persisted as it streams, so a
 * launch that dies keeps what it spent. A message id counts once, with its latest usage.
 */
export class OpenCall {
  /** The ids of the launch's row and of its helpers' rows, in the order they were opened. */
  readonly ids: number[];
  private readonly counted = new Map<string, PricedRequest>();
  private readonly helperRows = new Map<string, number>();
  private writes: Promise<void> = Promise.resolve();

  constructor(
    readonly id: number,
    readonly before: SpendBefore,
    private readonly draft: CallStart,
    private readonly calls: AgentCallRepository,
    private readonly clock: Clock,
    private readonly logger: Logger,
    /** The owner's spend as the log holds it now. */
    readonly spent: () => Promise<number>,
  ) {
    this.ids = [id];
  }

  /** Takes one model request as the stream gives it. */
  readonly onRequest = (request: PricedRequest): void => {
    this.writes = this.writes.then(() => this.count(request)).catch((error: unknown) => this.logger.error(error));
  };

  /** Ends the launch's row and its helpers' rows, once every request is persisted. */
  async finish(outcome: CallOutcome, stopped: boolean): Promise<void> {
    await this.writes;
    if ('result' in outcome) {
      await this.addUnstreamed(outcome.result);
    }
    const end = endOf(outcome, stopped, {
      iso: this.clock.iso(),
      durationMs: Math.max(0, this.clock.now() - Date.parse(this.draft.startedAt)),
    });
    await this.calls.finish(this.id, end);
    const { chatId: _chat, reported: _reported, responseText: _text, ...helperEnd } = end;
    await Promise.all(
      [...this.helperRows.values()].map((id) => this.calls.finish(id, { ...helperEnd, responseText: '' })),
    );
  }

  /**
   * What the result charges beyond the streamed requests (a model with no price row, or a runtime that streamed none)
   * is kept as one more request, so the log holds the whole cost the call was charged.
   */
  private async addUnstreamed(result: AgentRunResult): Promise<void> {
    const streamed = [...this.counted.values()].reduce((sum, request) => sum + request.usd, 0);
    const usd = result.usd - streamed;
    if (usd <= 1e-9) {
      return;
    }
    const none = this.counted.size === 0;
    await this.calls.addRequest(this.id, {
      model: this.draft.model,
      input: none ? result.tokensIn : 0,
      cacheRead: 0,
      cacheWrite: 0,
      output: none ? result.tokensOut : 0,
      usd,
      price: {},
    });
  }

  private async count(request: PricedRequest): Promise<void> {
    const row = await this.rowOf(request);
    const key = `${row}:${request.messageId}`;
    await this.calls.addRequest(row, difference(request, this.counted.get(key)));
    this.counted.set(key, request);
  }

  /** The row a request belongs to: the launch's own, or its helper's, opened on the helper's first request. */
  private async rowOf(request: PricedRequest): Promise<number> {
    const helper = request.parentToolUseId;
    if (helper === null) {
      return this.id;
    }
    const known = this.helperRows.get(helper);
    if (known !== undefined) {
      return known;
    }
    const id = await this.calls.open({
      ...this.draft,
      kind: 'helper',
      parentId: this.id,
      previousId: undefined,
      replacesId: undefined,
      startReason: undefined,
      chatId: undefined,
      resumed: false,
      chatIdleMin: undefined,
      model: request.model,
      requestText: '',
    });
    this.helperRows.set(helper, id);
    this.ids.push(id);
    return id;
  }
}

/** The one writer of the log's rows for a launch: it opens the row, takes the requests, and ends the row on every path. */
@Injectable()
export class AgentCallRecorder {
  private readonly logger = new Logger(AgentCallRecorder.name);

  constructor(
    private readonly calls: AgentCallRepository,
    private readonly contexts: CallContexts,
    private readonly clock: Clock,
  ) {}

  /** Opens the row of a launch, with the spend of its owner and the chat it resumes. */
  async begin(request: AgentLaunchRequest, opening: CallOpening): Promise<OpenCall> {
    const context = await this.contexts.resolve(request);
    const last = opening.chatId === null ? null : await this.calls.lastRowOfChat(opening.chatId);
    const draft = this.draft(request, context, {
      chatId: opening.chatId ?? undefined,
      resumed: opening.chatId !== null,
      previousId: last?.id,
      replacesId: opening.replacesId,
      chatIdleMin: last ? this.idleMinutes(last) : undefined,
      startReason: opening.followUp ? 'follow-up' : opening.replacesId !== undefined ? 'failover' : context.startReason,
    });
    const before = await this.spendBefore(context, opening.chatId, last);
    const spent = () =>
      context.owner === 'turn' ? this.calls.spendOfTurn(context.key) : this.calls.spendOfRun(context.key);
    const id = await this.calls.open(draft);
    // The ties its events name are known before the call runs, so a call that dies keeps them.
    if (request.call?.ties) {
      await this.calls.setTies(id, await request.call.ties(undefined));
    }
    return new OpenCall(id, before, draft, this.calls, this.clock, this.logger, spent);
  }

  /**
   * Opens the row of a keep-warm ping, keyed by its chat and the time it was due. Null when that due time already has a
   * row, so a second pass or a restart never pings it twice. The row belongs to the run and the chat's last step, with no attempt.
   */
  async beginPing(request: AgentLaunchRequest, ping: PingCall): Promise<OpenCall | null> {
    const context = await this.contexts.resolve(request);
    const last = await this.calls.lastRowOfChat(ping.chatId);
    const draft = this.draft(request, context, {
      chatId: ping.chatId,
      resumed: true,
      previousId: ping.previousId,
      chatIdleMin: last ? this.idleMinutes(last) : undefined,
      startReason: 'ping',
      attemptId: undefined,
    });
    const id = await this.calls.insertPing({
      startedAt: draft.startedAt,
      dueAt: ping.dueAt,
      chatId: ping.chatId,
      previousId: ping.previousId,
      runKey: context.key,
      step: context.step,
      backlog: context.backlog,
      taskSlug: context.taskSlug,
      epicKey: context.epicKey,
      chatIdleMin: draft.chatIdleMin,
      runtime: request.runtime,
      model: request.model,
      effort: request.effort,
      requestText: request.prompt,
    });
    if (id === null) return null;
    const before = await this.spendBefore(context, ping.chatId, last);
    const spent = () => this.calls.spendOfRun(context.key);
    return new OpenCall(id, before, draft, this.calls, this.clock, this.logger, spent);
  }

  /** Writes the row of a start the door refused, with its reason. */
  async refused(request: AgentLaunchRequest, reason: string): Promise<void> {
    const draft = this.draft(request, await this.contexts.resolve(request), { resumed: false });
    const id = await this.calls.open(draft);
    await this.calls.finish(id, {
      endKind: 'refused',
      refusedReason: reason,
      finishedAt: draft.startedAt,
      durationMs: 0,
      responseText: '',
    });
  }

  /** Ends the rows a dead process left open in the scope. Their streamed cost stays. */
  closeLeftOpen(scope: OpenScope): Promise<void> {
    return this.calls.closeLeftOpen(scope, this.clock.iso());
  }

  /** Sets the ties of the launch's rows from the value its result block held. */
  setTies(id: number, ties: Tie[]): Promise<void> {
    return this.calls.setTies(id, ties);
  }

  private draft(
    request: AgentLaunchRequest,
    context: CallContext,
    own: Partial<CallStart> & { resumed: boolean },
  ): CallStart {
    return {
      kind: 'call',
      startedAt: this.clock.iso(),
      runKey: context.owner === 'run' ? context.key : undefined,
      turnKey: context.owner === 'turn' ? context.key : undefined,
      backlog: context.backlog,
      taskSlug: context.taskSlug,
      epicKey: context.epicKey,
      step: context.step,
      plannerLevel: context.plannerLevel,
      purpose: context.purpose,
      startReason: context.startReason,
      attemptId: context.attemptId,
      runtime: request.runtime,
      model: request.model,
      effort: request.effort,
      requestText: request.prompt,
      ...own,
    };
  }

  private idleMinutes(last: AgentCallRow): number {
    const since = Date.parse(last.finishedAt || last.startedAt);
    return Math.max(0, (this.clock.now() - since) / MINUTE_MS);
  }

  private async spendBefore(
    context: CallContext,
    chatId: string | null,
    last: AgentCallRow | null,
  ): Promise<SpendBefore> {
    const turn = context.owner === 'turn';
    const [spentUsd, tokensInRun, chatSpentUsd] = await Promise.all([
      turn ? this.calls.spendOfTurn(context.key) : this.calls.spendOfRun(context.key),
      turn ? this.calls.tokensOfTurn(context.key) : this.calls.tokensOfRun(context.key),
      chatId === null ? 0 : this.calls.spendOfChat(chatId),
    ]);
    const reported =
      last && last.reportedUsd !== null && last.reportedTokensIn !== null && last.reportedTokensOut !== null
        ? { usd: last.reportedUsd, tokensIn: last.reportedTokensIn, tokensOut: last.reportedTokensOut }
        : NO_USAGE;
    return { spentUsd, tokensInRun, chatSpentUsd, prior: reported };
  }
}
