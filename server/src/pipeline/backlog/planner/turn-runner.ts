import { Injectable, Logger, Optional } from '@nestjs/common';
import { backlogTurn } from '../../../agent-result/definitions/backlog-turn';
import type { BacklogTurnResult } from '../../../agent-result/definitions/backlog-turn';
import type { AgentRunResult } from '../../../agent/agent-runner';
import { RunStop } from '../../../agent/run-stop';
import { StepStopped } from '../../../agent/step-stopped';
import { backlogPlanAgents, backlogReadAgents, type Agent } from '../../../config/agents';
import { AppConfig } from '../../../config/env';
import { LiveHub } from '../../../live/live.hub';
import { SwarmloopError } from '../../../core/swarmloop-error';
import { AttachmentStore } from '../../../history/attachment-store';
import { backlogMessageKey } from '../../../history/backlog-message-key';
import { AgentCallRepository } from '../../../history/agent-call.repository';
import { BacklogChatRepository } from '../../../history/backlog-chat.repository';
import type { BacklogMessageRecord, BacklogRecord, BacklogTurnRecord } from '../../../history/backlog-writers';
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
import { TurnTies } from './turn-ties';
import { turnView } from './planner-views';
import { TurnTakes } from './turn-takes';
import { waitOf } from './turn-wait';
import type { TurnOutcome } from './turn-wait';
import { BacklogTurnWorkspace } from './turn-workspace';

/** The step name of a planner turn's launch, for its chat, output file and agent role. */
const TURN_STEP = 'backlog-plan';

/** Adds the time a launch took to the turn's row. Its cost and tokens come from the log, not from the launch. */
function withDuration(row: BacklogTurnRecord, used: Pick<AgentRunResult, 'durationMs'>): BacklogTurnRecord {
  return { ...row, durationMs: (row.durationMs ?? 0) + used.durationMs };
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

/** The messages and events a turn holds. */
type Items = Awaited<ReturnType<BacklogChatRepository['itemsOfTurn']>>;

/** The items of `now` that `before` did not hold. */
function itemsAfter(now: Items, before: Items): Items {
  const known = {
    messages: new Set(before.messages.map((message) => message.id)),
    events: new Set(before.events.map((event) => event.id)),
  };
  return {
    messages: now.messages.filter((message) => !known.messages.has(message.id)),
    events: now.events.filter((event) => !known.events.has(event.id)),
  };
}

/** What one launch of a turn sends: the prompt of its chat, the whole brief for a chat that is gone, and the agent it runs on. */
interface TurnSend {
  prompt: string;
  brief?: string;
  agent?: Agent;
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
    private readonly calls: AgentCallRepository,
    private readonly ties: TurnTies,
    private readonly takes: TurnTakes,
    @Optional() private readonly live?: LiveHub,
  ) {}

  /** A usage limit of every agent and a code host outage are not failures: the outcome says when to try again. */
  async run(backlogName: string, turnKey: string): Promise<TurnOutcome> {
    const backlog = await this.backlogs.findBacklog(backlogName);
    if (backlog === null) throw new SwarmloopError(`no backlog ${backlogName}`);
    // A launch that halted this key (a missing credential) must not keep the turn from running again on Resume.
    this.runStop.clear(turnKey);
    try {
      const space = await this.workspace.open(backlog, turnKey);
      const held = await this.chat.itemsOfTurn(turnKey);
      await this.copyFiles(backlog.id as number, turnKey, held.messages);
      const brief = await this.prompt.build(backlogName, turnKey, space.mounts, space.names);
      const send = await this.sender(backlog, turnKey, space);
      let answer = await send({ prompt: brief });
      const added = await this.cameWhileWorking(backlog, turnKey, held);
      if (added) {
        const followUp = await this.prompt.followUp(backlogName, turnKey, added);
        answer = await send({ prompt: followUp, brief: `${brief}\n\n${followUp}`, agent: answer.agent });
      }
      await this.actions.apply(backlogName, turnKey, answer.value);
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

  /** Ends the log rows a dead process left open under the turn's key, keeping their cost, before the turn launches again. */
  closeLeftOpen(turnKey: string): Promise<void> {
    return this.launcher.closeLeftOpen({ turnKey });
  }

  /** What the turn took after its brief was written, once its take window is closed; null when nothing came. */
  private async cameWhileWorking(backlog: BacklogRecord, turnKey: string, held: Items): Promise<Items | null> {
    await this.takes.close(turnKey);
    const added = itemsAfter(await this.chat.itemsOfTurn(turnKey), held);
    if (added.messages.length + added.events.length === 0) return null;
    await this.copyFiles(backlog.id as number, turnKey, added.messages);
    return added;
  }

  /** The files of the given messages, copied into the turn's own folder so the planner finds them read only. */
  private async copyFiles(backlogId: number, turnKey: string, messages: BacklogMessageRecord[]): Promise<void> {
    const names = new Set(messages.flatMap((message) => message.attachments.map((file) => file.name)));
    if (names.size > 0) await this.attachments.copy(backlogMessageKey(backlogId), turnKey, [...names]);
  }

  /** Saves the turn's row with its cost and tokens as the log sums them for the turn's key. */
  private async withLogCost(row: BacklogTurnRecord): Promise<BacklogTurnRecord> {
    return this.chat.saveTurn({
      ...row,
      usd: await this.calls.spendOfTurn(row.turnKey),
      tokensIn: await this.calls.tokensOfTurn(row.turnKey),
      tokensOut: 0,
    });
  }

  /** The turn's launches: each one is a call of the same chat, on the agent given or the first of the role. */
  private async sender(
    backlog: BacklogRecord,
    turnKey: string,
    space: Awaited<ReturnType<BacklogTurnWorkspace['open']>>,
  ): Promise<(send: TurnSend) => Promise<{ value: BacklogTurnResult; agent: Agent }>> {
    const env = this.config.env;
    const dir = root(this.config);
    const stored = (await this.settings.read(backlog.owner))?.agents ?? null;
    const agents = backlogPlanAgents(env, stored);
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
        row = await this.withLogCost(withDuration(row, visit));
      },
      // What the turn's start waits for shows in the chat while the turn runs; none clears it.
      recordStartWait: async (wait) => {
        const reason = wait?.message ?? '';
        if (row.status !== 'running' || row.reason === reason) return;
        row = await this.chat.saveTurn({ ...row, reason });
        this.live?.backlog({ backlog: backlog.name, turn: turnView(row) });
      },
    };
    const record = async (used: AgentRunResult, ran: Agent) => {
      row = await this.withLogCost({
        ...withDuration(row, used),
        runtime: ran.runtime,
        model: ran.model,
        effort: ran.effort ?? null,
        transcript: outputFileFor(dir, turnKey, TURN_STEP, null),
      });
    };
    return async ({ prompt, brief, agent = agents[0] }) => {
      const { runtime, model, ...effort } = agent;
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
          // A chat that is gone, or another agent, starts from the whole brief; the first launch's prompt is that brief.
          ...(brief === undefined ? {} : { freshPrompt: brief, brief }),
          workspace: space.workspace,
          mounts: space.mounts,
          helpers: backlogReadAgents(env),
          failover: true,
          result: backlogTurn,
          check: nameRefusalsOnce((value) => this.actions.check(backlog.name, value)),
          call: { ties: await this.ties.of(backlog.id as number, turnKey) },
        });
        const ran: Agent = result.agent ?? agent;
        await record(result, ran);
        const failure = agentFailure(result, TURN_STEP, 'plan');
        if (failure) throw new SwarmloopError(`The planner's agent did not finish: ${failure}.`);
        if (result.resultValue === undefined) throw new SwarmloopError('the planner gave no usable answer');
        return { value: result.resultValue as BacklogTurnResult, agent: ran };
      } catch (error) {
        const tried =
          error instanceof ResultInvalid || error instanceof ModelHostUnavailable ? error.result : undefined;
        if (tried) await record(tried, agent);
        throw error;
      }
    };
  }
}
