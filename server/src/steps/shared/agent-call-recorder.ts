import { Injectable, Logger } from '@nestjs/common';
import type { AgentRunResult } from '../../agent/agent-result';
import type { PricedRequest } from '../../agent/request-usage';
import type { ChatUsage } from '../../agent/since-recorded';
import { NO_USAGE } from '../../agent/since-recorded';
import { Clock } from '../../core/clock';
import type { AgentCallRow, CallStart, ModelUsage, OpenScope, RequestUsage, Tie } from '../../history/agent-call';
import { AgentCallRepository } from '../../history/agent-call.repository';
import type { AgentLaunchRequest } from './agent-launch-request';
import { CallContexts } from './call-context';
import type { CallContext, CallSubject } from './call-context';
import { endOf } from './call-end';
import type { CallOutcome } from './call-end';
import { loggedPrice, uncountedUsage } from './uncounted-usage';

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
    price: loggedPrice(next.price),
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
    await this.calls.addRequest(
      this.id,
      {
        model: this.draft.model,
        input: none ? result.tokensIn : 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: none ? result.tokensOut : 0,
        usd,
        price: {},
      },
      none ? undefined : null,
    );
  }

  private async count(request: PricedRequest): Promise<void> {
    const row = await this.rowOf(request);
    const key = `${row}:${request.messageId}`;
    await this.calls.addRequest(
      row,
      difference(request, this.counted.get(key)),
      request.input + request.cacheRead + request.cacheWrite,
    );
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
    const last = opening.chatId === null ? null : await this.calls.lastCallOfChat(opening.chatId);
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

  /**
   * Counts the requests of an attempt's stream that no server read while they streamed: a container that outlived a
   * restart kept making them. What the attempt's rows for the step do not count yet goes on the attempt's last row
   * no visit holds; an attempt with no such row (the old process died before opening one) gets a row of its own.
   */
  async countStream(
    subject: CallSubject,
    agent: Pick<AgentLaunchRequest, 'runtime' | 'model' | 'effort'>,
    requests: PricedRequest[],
  ): Promise<void> {
    const attemptId = subject.run.activeAttempt;
    if (attemptId === null) return;
    const rows = await this.calls.rowsOfAttemptStep(attemptId, subject.step);
    const owed = uncountedUsage(
      requests,
      rows.flatMap((row) => (row.usage ? (JSON.parse(row.usage) as ModelUsage[]) : [])),
    );
    if (owed.length === 0) return;
    const open = [...rows].reverse().find((row) => row.kind === 'call' && row.stepStatId === 0);
    const id = open?.id ?? (await this.openOrphan(subject, agent));
    for (const usage of owed) {
      await this.calls.addRequest(id, usage);
    }
  }

  /** The row of a call whose process died before it wrote its own. It ends as failed, like every row a dead process left. */
  private async openOrphan(
    subject: CallSubject,
    agent: Pick<AgentLaunchRequest, 'runtime' | 'model' | 'effort'>,
  ): Promise<number> {
    const draft = this.draft({ ...subject, ...agent, prompt: '' }, await this.contexts.resolve(subject), {
      resumed: false,
    });
    const id = await this.calls.open(draft);
    await this.calls.finish(id, {
      endKind: 'failed',
      errorText: 'process died',
      finishedAt: draft.startedAt,
      durationMs: 0,
      responseText: '',
    });
    return id;
  }

  /** Sets the ties of the launch's rows from the value its result block held. */
  setTies(id: number, ties: Tie[]): Promise<void> {
    return this.calls.setTies(id, ties);
  }

  private draft(
    request: CallSubject & Pick<AgentLaunchRequest, 'runtime' | 'model' | 'effort' | 'prompt'>,
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
    const [spentUsd, chatSpentUsd] = await Promise.all([
      turn ? this.calls.spendOfTurn(context.key) : this.calls.spendOfRun(context.key),
      chatId === null ? 0 : this.calls.spendOfChat(chatId),
    ]);
    const reported =
      last && last.reportedUsd !== null && last.reportedTokensIn !== null && last.reportedTokensOut !== null
        ? { usd: last.reportedUsd, tokensIn: last.reportedTokensIn, tokensOut: last.reportedTokensOut }
        : NO_USAGE;
    return { spentUsd, chatSpentUsd, prior: reported };
  }
}
