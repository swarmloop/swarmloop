import Joi from 'joi';
import type { AddTaskBody, ChangeTaskBody } from '../../contract/backlog-actions';
import { defineResult } from '../result-definition';

/** One answer to an open question of a run. */
export interface TurnAnswer {
  kind?: string;
  id?: string;
  body: string;
}

interface Reasoned {
  /** One line that says why; an `answerRun`, a `passQuestion` or a `recordDecision` shows it as an info line, and an `answerRun` also records it as a decision. */
  reason?: string;
}

/** The typed actions of a planner turn: b01's actions except the owner's alone, and the commands a person sends to a run. */
export type BacklogTurnAction = Reasoned &
  (
    | { action: 'proposeMilestone'; title: string; goal: string }
    | { action: 'acceptMilestone'; milestone: number }
    | { action: 'addRequirements'; milestone: number; texts: string[] }
    | { action: 'recordDecision'; text: string }
    | { action: 'addTasks'; tasks: AddTaskBody[] }
    | ({ action: 'changeTask'; task: string } & ChangeTaskBody)
    | { action: 'deleteTask'; task: string }
    | { action: 'skipBacklogTask'; task: string }
    | { action: 'addItem'; id: string; title: string; description: string }
    | { action: 'moveItem'; task: string; milestone: number }
    | { action: 'dropItem'; task: string }
    | { action: 'pause' }
    | { action: 'unpause' }
    | { action: 'closeRequirement'; id: string; evidence: string }
    | { action: 'answerRun'; run: string; answers: TurnAnswer[] }
    | { action: 'passQuestion'; run: string; question?: string }
    | { action: 'planChat'; run: string; message: string }
    | { action: 'resume'; run: string }
    | { action: 'replay'; run: string; step: string }
    | { action: 'skipTask'; run: string; task: string }
    | { action: 'stop'; run: string }
  );

/** An action that sends a command to a run, as a person does. */
export type RunAction = Extract<BacklogTurnAction, { run: string }>;

export function isRunAction(action: object): action is RunAction {
  return 'run' in action;
}

/** What a planner turn hands to the server: a message for the person, and the actions it asks for. */
export interface BacklogTurnResult {
  say: string;
  actions: BacklogTurnAction[];
}

/** The fields each action needs, besides `action` itself. */
const REQUIRED: Record<BacklogTurnAction['action'], string[]> = {
  proposeMilestone: ['title', 'goal'],
  acceptMilestone: ['milestone'],
  addRequirements: ['milestone', 'texts'],
  recordDecision: ['text'],
  addTasks: ['tasks'],
  changeTask: ['task'],
  deleteTask: ['task'],
  skipBacklogTask: ['task'],
  addItem: ['id', 'title', 'description'],
  moveItem: ['task', 'milestone'],
  dropItem: ['task'],
  pause: [],
  unpause: [],
  closeRequirement: ['id', 'evidence'],
  answerRun: ['run', 'answers'],
  passQuestion: ['run', 'reason'],
  planChat: ['run', 'message'],
  resume: ['run'],
  replay: ['run', 'step'],
  skipTask: ['run', 'task'],
  stop: ['run'],
};

const text = (description: string): Joi.StringSchema => Joi.string().description(description);
const list = (description: string): Joi.ArraySchema => Joi.array().items(Joi.string()).description(description);

const taskFields = {
  title: text('The title'),
  description: text('The brief of the task'),
  repositories: list('The repositories of the backlog the task changes'),
  covers: list('The requirements the task covers, like M1.R2'),
  depends: list('The tasks or requirements it waits for'),
  files: list('The files it changes'),
  proof: list('The tests that prove it'),
  milestone: Joi.number().integer().description('The number of the milestone'),
};

const action = Joi.object({
  action: Joi.string()
    .valid(...Object.keys(REQUIRED))
    .required()
    .description('The action to take; the fields it needs are listed under it'),
  reason: text(
    'One line that says why. For answerRun, passQuestion and recordDecision it is shown to the person as an info line; for answerRun it is also kept as a decision. passQuestion needs it',
  ),
  ...taskFields,
  goal: text('proposeMilestone: the goal of the milestone'),
  texts: list('addRequirements: one requirement per entry'),
  tasks: Joi.array()
    .items(
      Joi.object({
        id: Joi.string().required().description('The task id: lowercase letters, digits and dashes'),
        fixesMain: text('The repository whose red main the task fixes'),
        manual: Joi.boolean().description('The task merges only on the owner OK'),
        ...taskFields,
      }).unknown(false),
    )
    .description('addTasks: the tasks to add'),
  task: text(
    'changeTask, deleteTask, skipBacklogTask, moveItem, dropItem: the task id; skipTask: the id of the run task',
  ),
  id: text('addItem: the item id; closeRequirement: the requirement, like M1.R2'),
  text: text('recordDecision: the decision'),
  evidence: text('closeRequirement: what shows the requirement is met'),
  run: text('answerRun, passQuestion, planChat, resume, replay, skipTask, stop: the run key'),
  question: text(
    'passQuestion: the id of the question to pass to the person; leave out to pass every question of the run you hold',
  ),
  answers: Joi.array()
    .items(Joi.object({ kind: Joi.string(), id: Joi.string(), body: Joi.string().required() }))
    .description(
      'answerRun: one answer per open question with its kind and id, or one answer with only a body, which answers every open question of the run',
    ),
  message: text('planChat: the message for the planner of the run'),
  step: text('replay: the step to run again'),
})
  .unknown(false)
  .custom((value: Record<string, unknown>, helpers) => {
    const missing = REQUIRED[value.action as BacklogTurnAction['action']].filter((key) => value[key] === undefined);
    return missing.length > 0
      ? helpers.message({ custom: `${String(value.action)} needs ${missing.join(', ')}` })
      : value;
  });

export const backlogTurn = defineResult(
  'backlog_turn',
  Joi.object({
    say: Joi.string()
      .empty('')
      .default('')
      .description(
        'A message for the person in plain words, markdown where it helps. No JSON, no field names, no ids of the system. May be empty',
      ),
    actions: Joi.array()
      .items(action)
      .default([])
      .description('The actions for the server to apply, in order; [] when there are none'),
  }),
);
