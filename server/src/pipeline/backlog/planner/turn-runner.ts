import { Injectable, Logger } from '@nestjs/common';
import { backlogTurn } from '../../../agent-result/definitions/backlog-turn';
import type { BacklogTurnResult } from '../../../agent-result/definitions/backlog-turn';
import type { AgentRunResult } from '../../../agent/agent-runner';
import { RunStop } from '../../../agent/run-stop';
import { StepStopped } from '../../../agent/step-stopped';
import { backlogPlanAgents } from '../../../config/agents';
import { AppConfig } from '../../../config/env';
import { effortFields } from '../../../contract/effort';
import { SwarmloopError } from '../../../core/swarmloop-error';
import { AttachmentStore } from '../../../history/attachment-store';
import { backlogMessageKey } from '../../../history/backlog-message-key';
import { BacklogChatRepository } from '../../../history/backlog-chat.repository';
import type { BacklogRecord, BacklogTurnRecord } from '../../../history/backlog-writers';
import { BacklogRepository } from '../../../history/backlog.repository';
import { root } from '../../../history/run-paths';
import { UserSettingRepository } from '../../../history/user-setting.repository';
import { outputFileFor } from '../../../core/attempt-output';
import { ResultInvalid } from '../../../steps/shared/answer-errors';
import { ModelHostUnavailable } from '../../../steps/shared/model-host-unavailable';
import { AgentLauncher } from '../../../steps/shared/agent-launcher';
import type { LaunchOwner } from '../../../steps/shared/agent-launch-request';
import { agentFailure } from '../../../steps/shared/agent-result';
import { PlannerTurnActions } from './planner-actions';
import { BacklogTurnPrompt } from './turn-prompt';
import { waitOf } from './turn-wait';
import type { TurnOutcome } from './turn-wait';
import { BacklogTurnWorkspace } from './turn-workspace';

/** The step name of a planner turn's launch, for its chat, output file and agent role. */
const TURN_STEP = 'backlog-plan';

/** Adds what a launch used to the turn's row. The agent that ran is the last one that took over. */
function withSpend(
  row: BacklogTurnRecord,
  used: Pick<AgentRunResult, 'tokensIn' | 'tokensOut' | 'usd' | 'durationMs'>,
): BacklogTurnRecord {
  return {
    ...row,
    tokensIn: (row.tokensIn ?? 0) + used.tokensIn,
    tokensOut: (row.tokensOut ?? 0) + used.tokensOut,
    usd: (row.usd ?? 0) + used.usd,
    durationMs: (row.durationMs ?? 0) + used.durationMs,
  };
}

/**
 * The check of a turn's launch: the refusals of the rules go back to the planner once, in the follow-up. An answer that
 * keeps a refused action passes the next time, and the apply drops the action with a line in the chat.
 */
function nameRefusalsOnce(
  check: (value: BacklogTurnResult) => Promise<string[]>,
): (value: unknown) => Promise<string[]> {
  let named = false;
  return async (value) => {
    if (named) return [];
    const refusals = await check(value as BacklogTurnResult);
    named = refusals.length > 0;
    return refusals;
  };
}

/** Runs one planner turn: opens its read only worktrees, launches the planner, applies its result, and closes the worktrees. */
@Injectable()
export class BacklogTurnRunner {
  private readonly logger = new Logger(BacklogTurnRunner.name);

  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly chat: BacklogChatRepository,
    private readonly settings: UserSettingRepository,
    private readonly workspace: BacklogTurnWorkspace,
    private readonly prompt: BacklogTurnPrompt,
    private readonly launcher: AgentLauncher,
    private readonly actions: PlannerTurnActions,
    private readonly config: AppConfig,
    private readonly runStop: RunStop,
    private readonly attachments: AttachmentStore,
  ) {}

  /** A usage limit of every agent and a code host outage are not failures: the outcome says when to try again. */
  async run(backlogName: string, turnKey: string): Promise<TurnOutcome> {
    const backlog = await this.backlogs.findBacklog(backlogName);
    if (backlog === null) throw new SwarmloopError(`no backlog ${backlogName}`);
    // A launch that halted this key (a missing credential) must not keep the turn from running again on Resume.
    this.runStop.clear(turnKey);
    try {
      const space = await this.workspace.open(backlog, turnKey);
      await this.copyFiles(backlog.id as number, turnKey);
      const prompt = await this.prompt.build(backlogName, turnKey, space.mounts, space.names);
      const value = await this.launch(backlog, turnKey, prompt, space);
      await this.actions.apply(backlogName, turnKey, value);
      return { status: 'done' };
    } catch (error) {
      const wait = waitOf(error);
      if (wait) return wait;
      if (error instanceof StepStopped) throw new SwarmloopError(error.message);
      throw error;
    } finally {
      await this.workspace.close(turnKey).catch((error: unknown) => {
        this.logger.warn(
          `turn ${turnKey}: worktrees not removed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }
  }

  /** The files of the person's messages this turn took, copied into the turn's own folder so the planner finds them read only. */
  private async copyFiles(backlogId: number, turnKey: string): Promise<void> {
    const { messages } = await this.chat.itemsOfTurn(turnKey);
    const names = new Set(messages.flatMap((message) => message.attachments.map((file) => file.name)));
    if (names.size > 0) await this.attachments.copy(backlogMessageKey(backlogId), turnKey, [...names]);
  }

  private async launch(
    backlog: BacklogRecord,
    turnKey: string,
    prompt: string,
    space: Awaited<ReturnType<BacklogTurnWorkspace['open']>>,
  ): Promise<BacklogTurnResult> {
    const env = this.config.env;
    const dir = root(this.config);
    const stored = (await this.settings.read(backlog.owner))?.agents ?? null;
    const agents = backlogPlanAgents(env, stored);
    const { runtime, model, ...effort } = agents[0];
    let row = (await this.chat.findTurn(turnKey)) as BacklogTurnRecord;
    const owner: LaunchOwner = {
      id: row.id as number,
      agentCalls: 0,
      spentUsd: row.usd ?? 0,
      activeAttempt: null,
      roleAgents: agents,
      get tokensSoFar() {
        return (row.tokensIn ?? 0) + (row.tokensOut ?? 0);
      },
      recordLimit: async (visit) => {
        row = await this.chat.saveTurn(withSpend(row, visit));
      },
    };
    const record = async (used: AgentRunResult, ran: { runtime: string; model: string; effort?: string }) => {
      row = await this.chat.saveTurn({
        ...withSpend(row, used),
        runtime: ran.runtime,
        model: ran.model,
        effort: ran.effort ?? null,
        transcript: outputFileFor(dir, turnKey, TURN_STEP, null),
      });
    };
    try {
      const result = await this.launcher.launch({
        root: dir,
        run: owner,
        login: backlog.owner,
        key: turnKey,
        step: TURN_STEP,
        mode: 'plan',
        tools: 'plan',
        runtime,
        model,
        ...effort,
        timeLimitMs: env.PLAN_TIMEOUT_MS,
        prompt,
        workspace: space.workspace,
        mounts: space.mounts,
        failover: true,
        result: backlogTurn,
        check: nameRefusalsOnce((value) => this.actions.check(backlog.name, value)),
      });
      const ran = result.agent ?? { runtime, model, ...effortFields(agents[0]) };
      await record(result, ran);
      const failure = agentFailure(result, TURN_STEP, 'plan');
      if (failure) throw new SwarmloopError(`The planner's agent did not finish: ${failure}.`);
      if (result.resultValue === undefined) throw new SwarmloopError('the planner gave no usable answer');
      return result.resultValue as BacklogTurnResult;
    } catch (error) {
      const tried = error instanceof ResultInvalid || error instanceof ModelHostUnavailable ? error.result : undefined;
      if (tried) {
        await record(tried, { runtime, model, ...effortFields(agents[0]) });
      }
      throw error;
    }
  }
}
