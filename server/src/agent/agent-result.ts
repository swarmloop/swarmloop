import type { EffortFields } from '../contract/effort';
import type { ChatUsage } from '../history/chat-usage.repository';
import type { SampleDraft } from '../history/visit';
import type { LimitHit } from '../integrations/agent-runtime/runtime-limit';
import type { ModelHostOutage } from '../integrations/agent-runtime/runtime-outage';
import type { RuntimeName } from '../integrations/agent-runtime/runtime-name';
import type { KillReason, ModelPrice } from './limits';
import type { HelperUsage, PricedModelUsage } from './request-usage';

export interface AgentRunResult {
  responseText: string;
  chatId: string | null;
  tokensIn: number;
  tokensOut: number;
  usd: number;
  /** The session totals the last result line reported, also when it reported the visit's own part. Null when it reported none. */
  reported?: ChatUsage | null;
  killReason: KillReason | null;
  exitCode: number;
  output?: string;
  resumed: boolean;
  /** Set while the stream was read. A later check does not parse the log again. */
  decided?: boolean;
  /** A background task was stopped or killed after the result line, and the answer lacks a required section. */
  backgroundKilled?: boolean;
  /** A resumed launch whose output was only orphan notifications and an empty result. */
  orphanOnly?: boolean;
  /** Set when the launch ran on another agent than the one asked for, because the first was limited or cooling down. */
  agent?: { runtime: RuntimeName; model: string } & EffortFields;
  /** The launch ended on the provider's usage limit. Nothing was answered, and the launch is not an attempt. */
  limit?: LimitHit;
  /** The launch ended because its model host did not answer after the CLI's own retries. Whatever was said is no answer. */
  outage?: ModelHostOutage;
  /** The main agent's own usage per model, summed from the call's requests. */
  byModel?: PricedModelUsage[];
  /** Each helper's usage by `parent_tool_use_id`. It is part of `usd`, and not of `byModel`. */
  helpers?: HelperUsage[];
  /** The price rows the requests were counted at, by model. */
  prices?: Record<string, ModelPrice>;
  calls: number;
  samples: SampleDraft[];
  durationMs: number;
  startedAt: string;
  finishedAt: string;
}

/** A result for a launch that never started. */
export function emptyResult(killReason: KillReason, exitCode: number, calls: number, now: string): AgentRunResult {
  return {
    responseText: '',
    chatId: null,
    tokensIn: 0,
    tokensOut: 0,
    usd: 0,
    killReason,
    exitCode,
    output: '',
    resumed: false,
    byModel: [],
    helpers: [],
    prices: {},
    calls,
    samples: [],
    durationMs: 0,
    startedAt: now,
    finishedAt: now,
  };
}
