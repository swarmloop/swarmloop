import { HttpException, Injectable } from '@nestjs/common';
import { isRunAction } from '../../../agent-result/definitions/backlog-turn';
import type { BacklogTurnAction, BacklogTurnResult } from '../../../agent-result/definitions/backlog-turn';
import type { MessageKind } from '../../../contract/backlog-chat';
import { Clock } from '../../../core/clock';
import { SwarmloopError } from '../../../core/swarmloop-error';
import { BacklogChatRepository } from '../../../history/backlog-chat.repository';
import type { BacklogRecord, BacklogWriters } from '../../../history/backlog-writers';
import { BacklogRepository } from '../../../history/backlog.repository';
import { commandOf, PlannerBacklogCalls } from './planner-backlog-calls';
import { PlannerRules } from './planner-rules';
import { PlannerRunPort } from './planner-run-port';
import { describeAction } from './planner-words';

/** An action the server did not take, and why. */
interface Dropped {
  index: number;
  action: BacklogTurnAction;
  reason: string;
}

/** What the rules and the service made of the actions of a turn. */
interface Evaluation {
  /** The number of the milestone the turn proposed, when it did. */
  proposed: number | null;
  dropped: Dropped[];
  /** The reasons the planner gave for the answers it wrote itself. */
  infos: { index: number; text: string }[];
}

/** Thrown to end `check`'s transaction: nothing it wrote stays. */
class CheckEnded extends Error {
  constructor(readonly evaluation: Evaluation) {
    super('check ended');
  }
}

/** Applies a turn's result: its actions through the action service in one transaction, then its commands to the runs, each once. */
@Injectable()
export class PlannerTurnActions {
  constructor(
    private readonly backlogs: BacklogRepository,
    private readonly chat: BacklogChatRepository,
    private readonly rules: PlannerRules,
    private readonly calls: PlannerBacklogCalls,
    private readonly port: PlannerRunPort,
    private readonly clock: Clock,
  ) {}

  /** The refusals of a result as lines for a person, written nothing: what `apply` would drop. */
  async check(backlogName: string, value: BacklogTurnResult): Promise<string[]> {
    const backlog = await this.load(backlogName);
    try {
      await this.backlogs.transaction(async (writers) => {
        throw new CheckEnded(await this.evaluate(backlog, 'check', value, writers));
      });
    } catch (error) {
      if (error instanceof CheckEnded) {
        return error.evaluation.dropped.map(({ action, reason }) => `${describeAction(action)}: ${reason}`);
      }
      throw error;
    }
    return [];
  }

  /** A turn that is applied is only sent again; one that is done is left as it is. */
  async apply(backlogName: string, turnKey: string, value: BacklogTurnResult): Promise<void> {
    const backlog = await this.load(backlogName);
    const turn = await this.chat.findTurn(turnKey);
    if (turn?.status === 'done') return;
    if (turn?.status !== 'applied') await this.write(backlog, turnKey, value);
    await this.send(backlog, turnKey);
  }

  private async write(backlog: BacklogRecord, turnKey: string, value: BacklogTurnResult): Promise<void> {
    const turn = await this.chat.findTurn(turnKey);
    await this.backlogs.transaction(async (writers) => {
      const evaluation = await this.evaluate(backlog, turnKey, value, writers);
      await this.lines(writers, backlog, turnKey, value, evaluation);
      await writers.saveTurn({
        backlogId: backlog.id as number,
        reason: '',
        nextTryAt: null,
        createdAt: this.clock.iso(),
        ...turn,
        turnKey,
        status: 'applied',
      });
    });
  }

  /** The recorded commands go out with the key of their place in the turn, so a resend runs none twice. */
  private async send(backlog: BacklogRecord, turnKey: string): Promise<void> {
    for (const { index, command } of await this.calls.recorded(backlog.id as number, turnKey)) {
      try {
        await this.port.send(command, backlog.owner, `${turnKey}-action-${index}`);
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        const text = `${command.run} refused the command: ${error.message}`;
        await this.say(this.backlogs, backlog, `${turnKey}-sent-${index}`, turnKey, text, 'refused');
      }
    }
    const turn = await this.chat.findTurn(turnKey);
    if (turn) await this.chat.saveTurn({ ...turn, status: 'done' });
  }

  /** Runs the rules and then the service for each action, in order, on the given writers. A refusal drops that action only. */
  private async evaluate(
    backlog: BacklogRecord,
    turn: string,
    value: BacklogTurnResult,
    writers: BacklogWriters,
  ): Promise<Evaluation> {
    const call = { owner: backlog.owner, backlog, context: { turn, writers } };
    const result: Evaluation = { proposed: null, dropped: [], infos: [] };
    for (const [index, given] of value.actions.entries()) {
      try {
        const judged = await this.rules.judge(writers, backlog, given);
        if ('refusal' in judged) {
          result.dropped.push({ index, action: given, reason: judged.refusal });
          continue;
        }
        const action = judged.action;
        if (isRunAction(action)) await this.calls.record(call, index, commandOf(action));
        else await this.calls.run(call, action);
        if (action.action === 'proposeMilestone') {
          const numbers = (await writers.milestones(backlog.id as number)).map((milestone) => milestone.number);
          result.proposed = Math.max(...numbers);
        }
        if (action.action === 'answerRun' && action.reason) {
          await this.calls.run(call, { action: 'recordDecision', text: action.reason });
          result.infos.push({ index, text: action.reason });
        }
      } catch (error) {
        if (!(error instanceof HttpException)) throw error;
        result.dropped.push({ index, action: given, reason: error.message });
      }
    }
    return result;
  }

  /** The planner's lines of the turn: what it said, why it answered, and each action it dropped. */
  private async lines(
    writers: BacklogWriters,
    backlog: BacklogRecord,
    turn: string,
    value: BacklogTurnResult,
    evaluation: Evaluation,
  ): Promise<void> {
    if (value.say.trim()) {
      await this.say(writers, backlog, `${turn}-say`, turn, value.say, 'message', evaluation.proposed);
    }
    for (const { index, text } of evaluation.infos) {
      await this.say(writers, backlog, `${turn}-info-${index}`, turn, text, 'info');
    }
    for (const { index, action, reason } of evaluation.dropped) {
      const text = `I did not ${describeAction(action)}: ${reason}`;
      await this.say(writers, backlog, `${turn}-refused-${index}`, turn, text, 'refused');
    }
  }

  private say(
    writers: Pick<BacklogWriters, 'addMessage'>,
    backlog: BacklogRecord,
    key: string,
    turn: string,
    text: string,
    kind: MessageKind,
    proposes: number | null = null,
  ): Promise<boolean> {
    return writers.addMessage({
      backlogId: backlog.id as number,
      messageKey: key,
      author: 'planner',
      kind,
      text,
      proposes,
      turn,
      attachments: [],
      createdAt: this.clock.iso(),
    });
  }

  private async load(name: string): Promise<BacklogRecord> {
    const backlog = await this.backlogs.findBacklog(name);
    if (backlog === null) throw new SwarmloopError(`no backlog ${name}`);
    return backlog;
  }
}
