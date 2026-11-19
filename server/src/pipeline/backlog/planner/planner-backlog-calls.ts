import { Injectable } from '@nestjs/common';
import type { BacklogTurnAction } from '../../../agent-result/definitions/backlog-turn';
import type { ChangeTaskBody } from '../../../contract/backlog-actions';
import type { BacklogRecord } from '../../../history/backlog-writers';
import { BacklogRepository } from '../../../history/backlog.repository';
import { RunRepository } from '../../../history/run.repository';
import { BacklogActionSupport, type PlannerContext } from '../backlog-action-support';
import { BacklogActions } from '../backlog-actions';
import type { PlannerRunCommand } from './planner-run-port';
import { stopReason } from './planner-run-state';

/** How many of the newest events are read for the commands of an applied turn; a turn's own are always among them. */
const EVENT_WINDOW = 1000;

/** The words an accepted run command is recorded under in the actions of the backlog. */
const COMMAND_WORDS: Record<PlannerRunCommand['type'], string> = {
  answer: 'answer run',
  resume: 'resume run',
  replay: 'replay run',
  skipTask: 'skip task of run',
  stop: 'stop run',
  planChat: 'write to run planner',
};

/** An action that sends a command to a run: it is recorded in the turn's transaction and sent after it. */
type RunAction = Extract<BacklogTurnAction, { run: string }>;

export function isRunAction(action: BacklogTurnAction): action is RunAction {
  return 'run' in action;
}

/** The command a run action asks for. */
export function commandOf(action: RunAction): PlannerRunCommand {
  switch (action.action) {
    case 'answerRun':
      return { type: 'answer', run: action.run, answers: action.answers };
    case 'planChat':
      return { type: 'planChat', run: action.run, message: action.message };
    case 'resume':
      return { type: 'resume', run: action.run };
    case 'replay':
      return { type: 'replay', run: action.run, step: action.step };
    case 'skipTask':
      return { type: 'skipTask', run: action.run, task: action.task };
    case 'stop':
      return { type: 'stop', run: action.run };
  }
}

/** What one action of a turn needs to run: who it acts for, on which backlog, in which turn. */
interface Call {
  owner: string;
  backlog: BacklogRecord;
  context: PlannerContext;
}

/** Runs the actions of a turn through the same service the HTTP routes use, as the owner of the backlog. */
@Injectable()
export class PlannerBacklogCalls {
  constructor(
    private readonly actions: BacklogActions,
    private readonly support: BacklogActionSupport,
    private readonly backlogs: BacklogRepository,
    private readonly runs: RunRepository,
  ) {}

  /** Runs a backlog action in the turn's transaction. */
  async run(call: Call, action: Exclude<BacklogTurnAction, RunAction>): Promise<void> {
    const { owner, backlog, context } = call;
    const name = backlog.name;
    switch (action.action) {
      case 'proposeMilestone':
        return this.actions.proposeMilestone(owner, name, action, context);
      case 'acceptMilestone':
        return this.actions.acceptMilestone(owner, name, action.milestone, context);
      case 'addRequirements':
        return this.actions.addRequirements(owner, name, action.milestone, action, context);
      case 'recordDecision':
        return this.actions.recordDecision(owner, name, action, context);
      case 'addTasks':
        return this.actions.addTasks(owner, name, action.tasks, context);
      case 'changeTask': {
        const { title, description, repositories, covers, depends, files, proof, milestone } = action;
        const changes: ChangeTaskBody = { title, description, repositories, covers, depends, files, proof, milestone };
        return this.actions.changeTask(owner, name, action.task, changes, context);
      }
      case 'deleteTask':
        return this.actions.deleteTask(owner, name, action.task, context);
      case 'skipBacklogTask':
        return this.actions.skipTask(owner, name, action.task, context);
      case 'addItem':
        return this.actions.addItem(owner, name, action, context);
      case 'moveItem':
        return this.actions.moveItem(owner, name, action.task, action, context);
      case 'dropItem':
        return this.actions.dropItem(owner, name, action.task, context);
      case 'pause':
        return this.actions.pause(owner, name, context);
      case 'unpause':
        return this.actions.unpause(owner, name, context);
      case 'closeRequirement':
        return this.actions.closeRequirement(owner, name, action.id, action, context);
    }
  }

  /** Records an accepted run command as an action of the backlog; the turn sends it after its transaction. */
  async record(call: Call, index: number, command: PlannerRunCommand): Promise<void> {
    const { type, run, ...payload } = command;
    await this.support.record(
      call.context.writers,
      call.backlog.id as number,
      call.owner,
      COMMAND_WORDS[type],
      {
        command: type,
        run,
        index: String(index),
        payload: JSON.stringify(payload),
        ...(type === 'resume' ? { blockCode: await stopReason(this.runs, run) } : {}),
      },
      call.context,
    );
  }

  /** The commands a turn recorded, in the order of its actions, each with its place in the turn. */
  async recorded(backlogId: number, turn: string): Promise<{ index: number; command: PlannerRunCommand }[]> {
    const events = await this.backlogs.events(backlogId, EVENT_WINDOW);
    return events
      .filter((event) => event.facts.turn === turn && event.facts.command !== undefined)
      .map((event) => ({
        index: Number(event.facts.index),
        command: {
          type: event.facts.command,
          run: event.facts.run,
          ...(JSON.parse(event.facts.payload) as object),
        } as PlannerRunCommand,
      }))
      .sort((left, right) => left.index - right.index);
  }
}
