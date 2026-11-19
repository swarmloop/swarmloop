import type { BacklogTurnAction } from '../../../agent-result/definitions/backlog-turn';

/** An action in plain words for the chat: what the planner asked for, without field names. */
export function describeAction(action: BacklogTurnAction): string {
  return 'run' in action ? describeRunAction(action) : describeBacklogAction(action);
}

type RunAction = Extract<BacklogTurnAction, { run: string }>;

function describeRunAction(action: RunAction): string {
  switch (action.action) {
    case 'answerRun':
      return `answer the run ${action.run}`;
    case 'planChat':
      return `write to the planner of ${action.run}`;
    case 'resume':
      return `resume ${action.run}`;
    case 'replay':
      return `replay ${action.step} of ${action.run}`;
    case 'skipTask':
      return `skip a task of ${action.run}`;
    case 'stop':
      return `stop ${action.run}`;
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
  }
}
