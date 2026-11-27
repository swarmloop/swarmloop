import Joi from 'joi';
import type { AddTaskBody, ChangeTaskBody } from '../../contract/backlog-actions';
import { requiredBy } from '../required-by';
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
    | { action: 'replay'; run: string; step: string; instruction: string }
    | { action: 'rebase'; run: string }
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
  replay: ['run', 'step', 'instruction'],
  rebase: ['run'],
  skipTask: ['run', 'task'],
  stop: ['run'],
};

/** The fields an action may give of its own, besides `reason`, which every action takes. */
const OPTIONAL: Partial<Record<BacklogTurnAction['action'], string[]>> = {
  changeTask: ['title', 'description', 'repositories', 'covers', 'depends', 'files', 'proof', 'milestone'],
  passQuestion: ['question'],
};

/** The fields each action may also give: its own optional ones, and `reason` where the action does not need it. */
const TAKES = Object.fromEntries(
  Object.entries(REQUIRED).map(([name, needs]) => [
    name,
    [...(OPTIONAL[name as BacklogTurnAction['action']] ?? []), ...(needs.includes('reason') ? [] : ['reason'])],
  ]),
) as Record<BacklogTurnAction['action'], string[]>;

const text = (description: string): Joi.StringSchema => Joi.string().description(description);
const list = (description: string): Joi.ArraySchema => Joi.array().items(Joi.string()).description(description);

const taskFields = {
  title: text('The title'),
  description: text('The brief of the task'),
  repositories: list('The repositories of the backlog the task changes'),
  covers: list('The requirements the task covers, like M1.R2'),
  depends: list('The tasks or requirements it waits for'),
  files: list('The files it changes'),
  proof: list(
    "The tests or checks that prove it, each one something the task's own run can check (a test, a check command or a CI job of its repository); never git, which a planner turn does not have",
  ),
  milestone: Joi.number().integer().description('The number of the milestone'),
};

const action = requiredBy(
  Joi.object({
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
          id: Joi.string().required().description("The task's slug: lowercase letters, digits and dashes"),
          fixesMain: text('The repository whose red main the task fixes'),
          manual: Joi.boolean().description('The task merges only on the owner OK'),
          ...taskFields,
          title: text('The title; the server refuses a new task without it'),
          description: text('The brief of the task; the server refuses a new task without it'),
        }).unknown(false),
      )
      .description('addTasks: the tasks to add'),
    task: text(
      'changeTask, deleteTask, skipBacklogTask, moveItem, dropItem: the task id; skipTask: the id of the run task',
    ),
    id: text('addItem: the item id; closeRequirement: the requirement, like M1.R2'),
    text: text('recordDecision: the decision'),
    evidence: text('closeRequirement: what shows the requirement is met'),
    run: text(
      "answerRun, passQuestion, planChat, resume, replay, rebase, skipTask, stop: the run by its key; a task's run or any run below it, such as a part of an epic",
    ),
    question: text(
      "passQuestion: pass a run's question to the person; the id of the question, or leave it out to pass every question of the run you hold",
    ),
    answers: Joi.array()
      .items(Joi.object({ kind: Joi.string(), id: Joi.string(), body: Joi.string().required() }))
      .description(
        'answerRun: one answer per open question with its kind and id, or one answer with only a body, which answers every open question of the run',
      ),
    message: text('planChat: the message for the planner of the run'),
    step: text('replay: replay a run from a step with an instruction; the step to start from'),
    instruction: text('replay: what the step starts with, as a person writes it in Replay'),
  }).unknown(false),
  'action',
  REQUIRED,
  TAKES,
);

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
