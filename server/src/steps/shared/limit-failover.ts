import { Injectable } from '@nestjs/common';
import { AppConfig } from '../../config/env';
import { agentsFor, availableAgent } from '../../config/agents';
import type { AgentRunResult } from '../../agent/agent-result';
import { ERROR_CODES } from '../../contract/error-codes';
import { Clock } from '../../core/clock';
import { RuntimeLimit } from '../../core/swarmloop-error';
import { recordStepEvent } from '../../core/step-event-scope';
import type { VisitDraft } from '../../history/visit';
import type { RunEntity } from '../../history/entities';
import { RuntimeCooldownRepository } from '../../history/runtime-cooldown.repository';
import { VisitRepository } from '../../history/visit.repository';
import type { RuntimeName } from '../../integrations/agent-runtime/runtime-name';
import type { Route } from '../contract/step-contract';

/** What a launch that may move to another agent tells the failover. */
interface FailoverTarget {
  run: RunEntity;
  step: string;
  liveStep?: string;
  mode: string;
  runtime: RuntimeName;
  model: string;
  prompt: string;
  /** The full prompt for a new chat on another agent. A follow-up prompt only a resumed chat can use never goes there. */
  brief?: string;
  /** The full prompt for a new chat on the given runtime. A prompt built for another runtime may miss rule files it loads by itself. */
  briefFor?: (runtime: RuntimeName) => string;
  freshPrompt?: string;
  resume?: boolean;
  auto?: boolean;
}

/** The furthest reset a provider's text may name. Provider windows are hours to a week. */
const MAX_RESET_MS = 7 * 24 * 3_600_000;

const NAMES: Record<RuntimeName, string> = { claude: 'Claude', codex: 'Codex', cursor: 'Cursor' };

function clock(iso: string): string {
  return `${iso.slice(11, 16)} UTC`;
}

/** `Claude hit its usage limit (resets 21:50 UTC).` The time is left out when the provider gave none. */
function limitText(runtime: RuntimeName, resetsAt: string | undefined): string {
  return `${NAMES[runtime]} hit its usage limit${resetsAt ? ` (resets ${clock(resetsAt)})` : ''}.`;
}

/**
 * What a provider limit does to a launch: the runtime cools down, the limited launch is recorded and not counted as an
 * attempt, and the launch goes on at once with the next agent of the role, or the run waits when none is left.
 */
@Injectable()
export class LimitFailover {
  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly cooldowns: RuntimeCooldownRepository,
    private readonly visits: VisitRepository,
  ) {}

  /** A new launch skips a cooling runtime. A person's Resume goes ahead on the agent it has even then. */
  async start<T extends FailoverTarget>(request: T): Promise<T> {
    const cooling = await this.cooldowns.cooling(this.clock.now());
    if (!cooling.has(request.runtime)) {
      return request;
    }
    const next = availableAgent(this.config.env, request.run, this.use(request), cooling);
    if (next) {
      const moved = { ...request, ...next };
      return next.runtime !== request.runtime && request.briefFor
        ? { ...moved, prompt: request.briefFor(next.runtime) }
        : moved;
    }
    if (request.auto) {
      throw await this.waiting(request, request.runtime, undefined);
    }
    return request;
  }

  /** Records a limited launch. Returns the request moved to the next agent, or throws `RuntimeLimit` when none is left. */
  async limited<T extends FailoverTarget>(request: T, result: AgentRunResult): Promise<T> {
    const { window } = result.limit ?? {};
    const now = this.clock.now();
    // A reset far in the future is not a provider's window: the default cooldown applies, and no time is shown.
    const named = Date.parse(result.limit?.resetsAt ?? '');
    const known = named > now && named <= now + MAX_RESET_MS;
    const resetsAt = known ? new Date(named).toISOString() : undefined;
    const end = known ? named : now + this.config.env.LIMIT_COOLDOWN_MIN * 60_000;
    await this.cooldowns.set(request.runtime, end, known);
    await this.visits.finishVisit(request.run, this.visit(request, result));
    const next = availableAgent(this.config.env, request.run, this.use(request), await this.cooldowns.cooling(now));
    if (!next) {
      throw await this.waiting(request, request.runtime, window, resetsAt);
    }
    const continuedWith = `${next.runtime}:${next.model}`;
    recordStepEvent({
      kind: 'agent.limited',
      runtime: request.runtime,
      window,
      resetsAt,
      continuedWith,
      text: `${limitText(request.runtime, resetsAt)} Continued with ${continuedWith}.`,
    });
    // A chat cannot move between runtimes: the new agent starts a new chat with the full brief.
    return {
      ...request,
      ...next,
      resume: false,
      prompt: request.briefFor?.(next.runtime) ?? request.brief ?? request.prompt,
      freshPrompt: undefined,
    };
  }

  /** The error of a step whose every agent of the role is limited. It says when the run goes on. */
  private async waiting(
    request: FailoverTarget,
    runtime: RuntimeName,
    window: string | undefined,
    resetsAt?: string,
  ): Promise<RuntimeLimit> {
    const runtimes = agentsFor(this.config.env, request.run, this.use(request)).map((agent) => agent.runtime);
    const { until, resumeAt } = await this.cooldowns.earliest(runtimes);
    const resumesAt = new Date(resumeAt).toISOString();
    const reset = resetsAt ?? (until > 0 ? new Date(until).toISOString() : undefined);
    const text = `${limitText(runtime, reset)} Every agent of the role is limited. The run goes on at ${clock(resumesAt)}.`;
    recordStepEvent({ kind: 'agent.limited', runtime, window, resetsAt: reset, resumesAt, text });
    return new RuntimeLimit(text, runtime, resumesAt, window, reset);
  }

  private use(request: FailoverTarget): string {
    return request.liveStep ?? request.step;
  }

  private visit(request: FailoverTarget, result: AgentRunResult): VisitDraft {
    return {
      step: this.use(request),
      runtime: request.runtime,
      model: request.model,
      mode: request.mode,
      startedAt: result.startedAt,
      finishedAt: result.finishedAt,
      durationMs: result.durationMs,
      status: 'interrupted',
      exitCode: result.exitCode,
      killReason: ERROR_CODES.RUNTIME_LIMIT,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      usd: result.usd,
      samples: result.samples,
      exchange: null,
      httpCalls: [],
      document: null,
      documents: [],
      resumed: result.resumed,
    };
  }
}

/** The route of a step that waits for a provider limit to end. */
export function limitRoute(error: RuntimeLimit): Route {
  return {
    to: 'wait',
    reason: error.message,
    code: ERROR_CODES.RUNTIME_LIMIT,
    limit: { runtime: error.runtime, window: error.window, resetsAt: error.resetsAt, resumesAt: error.resumesAt },
  };
}
