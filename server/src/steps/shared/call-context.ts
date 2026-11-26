import { Injectable } from '@nestjs/common';
import { REASON } from '../../contract/reason-words';
import { BacklogChatRepository } from '../../history/backlog-chat.repository';
import { BacklogRepository } from '../../history/backlog.repository';
import type { RunEntity } from '../../history/entities';
import { RunRepository } from '../../history/run.repository';
import { VisitStartRepository } from '../../history/visit-start.repository';
import type { AgentLaunchRequest } from './agent-launch-request';

/** The step name of a backlog planner's turn: its launches are the turn's, not a run's. */
const TURN_STEP = 'backlog-plan';

/** The steps whose name is the purpose of the call, when the caller names none. */
const PLANNER_STEPS: readonly string[] = ['research', 'plan', 'plan-improve'];

/** What names a call to the log: the run's key and step, its purpose, and the attempt that runs it. */
export type CallSubject = Pick<AgentLaunchRequest, 'key' | 'step' | 'liveStep' | 'call'> & {
  run: Pick<AgentLaunchRequest['run'], 'activeAttempt'>;
};

/** The facts of a call the log records, resolved from the run key. A turn's key is its own, never a run's. */
export interface CallContext {
  /** Whether the owner is a run or a backlog planner's turn. */
  owner: 'run' | 'turn';
  key: string;
  backlog?: string;
  taskSlug?: string;
  epicKey?: string;
  step: string;
  plannerLevel?: 'run' | 'epic' | 'backlog';
  purpose?: string;
  startReason: string;
  attemptId?: string;
}

/** How the call began: the visit's start row says why the step ran; a one-off call says why it was made. */
function startReasonOf(
  step: string,
  purpose: string | undefined,
  start: { startReason: string | null; rerunUnfinished: boolean } | undefined,
): string {
  if (step === 'rebase') return 'rebase';
  if (purpose === 'merge-look') return 'merge';
  if (purpose?.startsWith('answer-') || purpose === 'backlog-turn') return 'message';
  if (start?.startReason === REASON.stopped) return 'resume';
  if (start?.startReason === REASON.returned) return `return:${step}`;
  return start?.rerunUnfinished ? 'retry' : 'first';
}

/** Resolves what the log records of a call that the request does not carry. */
@Injectable()
export class CallContexts {
  constructor(
    private readonly runs: RunRepository,
    private readonly backlogs: BacklogRepository,
    private readonly turns: BacklogChatRepository,
    private readonly starts: VisitStartRepository,
  ) {}

  async resolve(request: CallSubject): Promise<CallContext> {
    const step = request.liveStep ?? request.step;
    const attemptId = request.run.activeAttempt ?? undefined;
    return request.step === TURN_STEP ? this.turn(request, step, attemptId) : this.run(request, step, attemptId);
  }

  /** A backlog planner's turn: its key is its own, and its planner is the backlog planner. */
  private async turn(request: CallSubject, step: string, attemptId: string | undefined): Promise<CallContext> {
    const turn = await this.turns.findTurn(request.key);
    const backlog = (await this.backlogs.listBacklogs()).find((row) => row.id === turn?.backlogId)?.name;
    const purpose = request.call?.purpose ?? 'backlog-turn';
    return {
      owner: 'turn',
      key: request.key,
      backlog,
      step,
      plannerLevel: 'backlog',
      purpose,
      startReason: startReasonOf(step, purpose, undefined),
      attemptId,
    };
  }

  /** A run's call: the task, backlog and epic it belongs to, and why its step started. */
  private async run(request: CallSubject, step: string, attemptId: string | undefined): Promise<CallContext> {
    const run = await this.runs.findRun(request.key);
    const purpose = request.call?.purpose ?? (PLANNER_STEPS.includes(step) ? step : undefined);
    const starts = run && attemptId ? await this.starts.forRun(run.id) : [];
    const epic = run ? await this.epicOf(run) : undefined;
    const task =
      (await this.backlogs.findTaskByRunKey(request.key)) ??
      (epic ? await this.backlogs.findTaskByRunKey(epic.key) : null);
    const taskKey = task?.runKey ?? '';
    return {
      owner: 'run',
      key: request.key,
      backlog: task ? (await this.backlogs.labelsFor([taskKey])).get(taskKey)?.name : undefined,
      taskSlug: task?.slug,
      epicKey: epic?.key,
      step,
      plannerLevel: purpose ? (epic?.parent ? 'epic' : 'run') : undefined,
      purpose,
      startReason: startReasonOf(
        step,
        purpose,
        starts.find((start) => start.attemptId === attemptId),
      ),
      attemptId,
    };
  }

  /** The epic a run belongs to: its parent's key for a part, its own for an epic's parent. */
  private async epicOf(run: RunEntity): Promise<{ key: string; parent: boolean } | undefined> {
    if (run.parentRunId !== null) {
      const parent = await this.runs.findById(run.parentRunId);
      return parent ? { key: parent.key, parent: false } : undefined;
    }
    return (await this.runs.children(run)).length > 0 ? { key: run.key, parent: true } : undefined;
  }
}
