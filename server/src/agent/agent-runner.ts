import { Injectable, Logger, Optional } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { PersonalCredentials } from '../auth/personal-credentials.service';
import { RunRepository } from '../history/run.repository';
import { LiveHub } from '../live/live.hub';
import { SwarmloopError } from '../core/swarmloop-error';
import { Clock } from '../core/clock';
import type { AgentTools } from '../integrations/agent-runtime/agent-runtime';
import { runtimeFor } from '../integrations/agent-runtime/agent-runtime.registry';
import { SandboxService } from '../sandbox/sandbox.service';
import type { AgentRunInput as BaseAgentRunInput } from './agent-run-input';
import { emptyResult, stoppedFromOutside, type AgentRunResult } from './agent-result';
export type { AgentRunResult } from './agent-result';
import { callsExceeded } from './limits';
import { NO_USAGE, type ChatUsage } from './since-recorded';
import { RunStop } from './run-stop';
import { AgentLaunch } from './agent-launch';
import { AgentLaunchEnv } from './agent-launch-env';
import { AgentLaunchPrep } from './agent-launch-prep';
import {
  backgroundKilledContinue,
  foldAttempt,
  relaunchPlan,
  resendAfterOrphans,
  carriedOutput,
  chatMissingAnswer,
  dropMissingChat,
} from './agent-session';

export { buildAgentArgs, reviewBriefMount, spillPrompt } from './agent-args';
export { AGENT_CONTINUE, readSession } from './agent-session';

export const AGENT_RUNNER = Symbol('AGENT_RUNNER');

export type AgentRunInput = BaseAgentRunInput & { tools: AgentTools };

/** What a chat holds before a launch: the session totals it last reported, and what it has cost so far. */
interface ChatSpend {
  prior: ChatUsage;
  usd: number;
}

const NO_CHAT_SPEND: ChatSpend = { prior: NO_USAGE, usd: 0 };

function chatSpendOf(input: AgentRunInput): ChatSpend {
  return { prior: input.prior ?? NO_USAGE, usd: input.chatSpentUsd ?? 0 };
}

/** A launch that reported no session totals leaves the chat with none: the next session total counts whole. */
function chatSpendAfter(chat: ChatSpend, attempt: AgentRunResult): ChatSpend {
  return { prior: attempt.reported ?? NO_USAGE, usd: chat.usd + attempt.usd };
}

@Injectable()
export class AgentProcessRunner {
  private readonly logger = new Logger(AgentProcessRunner.name);
  private readonly launchPrep: AgentLaunchPrep;
  private readonly launch: AgentLaunch;

  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly sandbox: SandboxService,
    private readonly runStop: RunStop,
    @Optional() private readonly live?: LiveHub,
    @Optional() private readonly credentials?: PersonalCredentials,
    @Optional() private readonly runs?: RunRepository,
  ) {
    this.launchPrep = new AgentLaunchPrep(config, live);
    this.launch = new AgentLaunch(
      config,
      clock,
      sandbox,
      runStop,
      this.logger,
      this.launchPrep,
      new AgentLaunchEnv(clock),
      live,
      credentials,
      runs,
    );
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    try {
      const env = this.config.env;
      if (input.auto === true && callsExceeded(input.agentCalls, env.MAX_AGENT_CALLS)) {
        return emptyResult('calls', 1, 0, this.clock.iso());
      }
      const runtime = runtimeFor(input.runtime);
      await this.sandbox.assertReady(input.runtime);
      const carried = await carriedOutput(input);
      let calls = 0;
      let tries = 0;
      let prompt = input.prompt;
      let prior = carried;
      let chatId = input.resumeChatId;
      let resumed = chatId !== null;
      let chat = chatSpendOf(input);
      let merged: AgentRunResult | null = null;
      let endedEarlyUsed = false;
      let resent = false;
      let freshPrompt = input.freshPrompt;
      for (;;) {
        const attempt = await this.launch.once(
          {
            ...input,
            prompt,
            resumeChatId: chatId,
            prior: chat.prior,
            chatSpentUsd: chat.usd,
            agentCalls: input.agentCalls + calls,
          },
          runtime,
          resumed,
          prior,
        );
        merged = foldAttempt(merged, attempt);
        calls += attempt.calls;
        chat = chatSpendAfter(chat, attempt);
        if (input.fork) {
          // A fork changes nothing: no second launch, no dropped chat, no resent prompt.
          return merged;
        }
        if (attempt.limit) {
          // A limit is no attempt: relaunching into it only burns launches. The caller picks another agent or waits.
          return merged;
        }
        if (attempt.outage) {
          // The CLI already retried its API calls: relaunching only burns launches. The caller waits for the host.
          return merged;
        }
        if (this.endedFromOutside(attempt, input.runKey)) {
          // A container stopped from outside: relaunching into it only burns launches. The caller waits.
          return merged;
        }
        prior = `${carried}${merged.output ?? ''}`;
        const budget = {
          halted: this.runStop.halted(input.runKey),
          callsSoFar: input.agentCalls + calls,
          maxCalls: env.MAX_AGENT_CALLS,
          attempts: tries,
          maxLaunches: env.MAX_LAUNCHES,
        };
        if (resendAfterOrphans({ attempt, resumed, resent, budget })) {
          resent = true;
          chatId = attempt.chatId ?? chatId;
          prompt = backgroundKilledContinue(input.answerEnding);
          continue;
        }
        const fresh = chatMissingAnswer(attempt) ? await dropMissingChat(input, freshPrompt) : null;
        if (fresh !== null) {
          // The stored id points at nothing: one fresh chat with the full prompt, never a second try.
          freshPrompt = undefined;
          chatId = null;
          resumed = false;
          chat = NO_CHAT_SPEND;
          prompt = fresh;
          continue;
        }
        tries += 1;
        budget.attempts = tries;
        const relaunch = relaunchPlan({
          attempt,
          chatId,
          continuePrompt: input.continuePrompt,
          loopPrompt: attempt.killReason === 'loop' ? input.loop?.resumePrompt() : null,
          endedEarlyUsed,
          budget,
          ending: input.answerEnding,
        });
        if (!relaunch) {
          if (!merged) {
            throw new SwarmloopError('agent returned nothing');
          }
          return merged;
        }
        endedEarlyUsed ||= relaunch.prompt === backgroundKilledContinue(input.answerEnding);
        chatId = relaunch.chatId;
        resumed = relaunch.resumed;
        chat = resumed ? chat : NO_CHAT_SPEND;
        prompt = relaunch.prompt ?? prompt;
      }
    } finally {
      this.dropLiveSpend(input);
    }
  }

  /** A launch a signal ended with no Stop behind it: the container was stopped from outside. */
  private endedFromOutside(attempt: AgentRunResult, runKey: string): boolean {
    return stoppedFromOutside(attempt) && !this.runStop.halted(runKey);
  }

  /** A launch that is a visit shows its spend live until it ends; a fork shows none. */
  private dropLiveSpend(input: AgentRunInput): void {
    if (!input.fork) this.live?.dropSpend(input.runKey, input.liveStep ?? input.step);
  }
}
