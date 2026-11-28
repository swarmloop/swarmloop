import { isRunAction } from '../../../agent-result/definitions/backlog-turn';
import type { BacklogTurnAction, RunAction } from '../../../agent-result/definitions/backlog-turn';
import { commandOf } from './planner-backlog-calls';
import type { PlannerRunCommand } from './planner-run-port';

/** An action in plain words for the chat: what the planner asked for, without field names. */
export function describeAction(action: BacklogTurnAction): string {
  return isRunAction(action) ? describeRunAction(action) : describeBacklogAction(action);
}

function describeRunAction(action: RunAction): string {
  return describeCommand(commandOf(action));
}

/** A command to a run in plain words for the chat. */
export function describeCommand(command: PlannerRunCommand): string {
  switch (command.type) {
    case 'answer':
      return `answer the run ${command.run}`;
    case 'planChat':
      return `write to the planner of ${command.run}`;
    case 'passOn':
      return `pass the question of ${command.run} to the person`;
    case 'resume':
      return `resume ${command.run}`;
    case 'replay':
      return `replay ${command.step} of ${command.run}`;
    case 'rebase':
      return `rebase ${command.run}`;
    case 'skipTask':
      return `skip a task of ${command.run}`;
    case 'stop':
      return `stop ${command.run}`;
  }
}

function describeBacklogAction(action: Exclude<BacklogTurnAction, RunAction>): string {
  switch (action.action) {
    case 'proposeMilestone':
      return `propose the milestone "${action.title}"`;
    case 'acceptMilestone':
      return `accept milestone M${action.milestone}`;
    case 'addRequirements':
      return `add requirements to milestone M${action.milestone}`;
    case 'recordDecision':
      return 'record a decision';
    case 'addTasks':
      return `add ${action.tasks.map((task) => task.id).join(', ')}`;
    case 'changeTask':
      return `change ${action.task}`;
    case 'deleteTask':
      return `delete ${action.task}`;
    case 'skipBacklogTask':
      return `skip ${action.task}`;
    case 'addItem':
      return `add the item ${action.id}`;
    case 'moveItem':
      return `move ${action.task} to milestone M${action.milestone}`;
    case 'dropItem':
      return `drop ${action.task}`;
    case 'pause':
      return 'pause the backlog';
    case 'unpause':
      return 'unpause the backlog';
    case 'closeRequirement':
      return `close ${action.id}`;
    case 'offerRun':
      return action.milestone === undefined
        ? `offer to run ${action.task}`
        : `offer to run milestone M${action.milestone}`;
  }
}
