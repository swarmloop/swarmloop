import Joi from 'joi';
import { defineResult, type ResultDefinition } from '../result-definition';
import { planKeys, STARTER_FIELDS, type PlanResult } from './plan';
import { keysFor, storedContractKey } from './split-fields';

/** What the planner hands back to a person: a short answer, and when the plan changes, the plan itself. */
export interface PlanReplyResult extends Partial<Omit<PlanResult, 'questions'>> {
  reply: string;
  /** What whoever started the run must decide, when the planner cannot settle it. */
  escalate?: string;
  /** The texts of the requirements the reply adds. */
  requirements?: string[];
}

/** What a run lets a reply change. */
interface ReplyShape {
  split: boolean;
  subtask: boolean;
  /** The tasks in the reply are only the ones to add. */
  addTasksOnly?: boolean;
  /** The reply answers and changes nothing: no requirements and no plan. */
  answerOnly?: boolean;
}

const SPLIT_KEYS = ['contract', 'tasks', 'keep'];
const PLAN_SCHEMAS: Record<string, Joi.Schema> = planKeys;
const PLAN_KEYS = Object.keys(PLAN_SCHEMAS);

const ownKeys = {
  reply: Joi.string()
    .required()
    .description('A short answer in plain words for a person, markdown where it helps. No JSON, no field names'),
  escalate: Joi.string().description(
    'What whoever started the run must decide, when you cannot settle it. Never invent a product decision',
  ),
  requirements: Joi.array()
    .items(Joi.string())
    .default([])
    .description(
      'The text of each new requirement, one per entry, when the message asks for something new; [] when none',
    ),
};

/** The plan fields of a reply are all optional: a reply without them changes nothing. */
function planPart(addTasksOnly: boolean, stored: boolean): Record<string, Joi.Schema> {
  const optional = Object.fromEntries(Object.entries(PLAN_SCHEMAS).map(([name, schema]) => [name, schema.optional()]));
  return {
    ...optional,
    ...(stored ? { contract: storedContractKey() } : {}),
    plan: PLAN_SCHEMAS.plan.description(
      'The whole checklist as it is now, one item per entry; leave out when the plan stays',
    ),
    ...(addTasksOnly
      ? { tasks: PLAN_SCHEMAS.tasks.description('Only the tasks to add; the tasks already there stay as they are') }
      : {}),
  };
}

function schemaOf(hidden: string[], shape: Pick<ReplyShape, 'addTasksOnly'>, stored = false): Joi.ObjectSchema {
  const keys = { ...ownKeys, ...planPart(Boolean(shape.addTasksOnly), stored) };
  return Joi.object(keysFor(keys, hidden))
    .unknown(hidden.length > 0)
    .custom((value: PlanReplyResult, helpers) =>
      value.plan?.length && value.tasks?.length
        ? helpers.message({ custom: 'plan and tasks cannot both be filled in' })
        : value,
    );
}

/** Every field of the plan reply: the definition its stored kind is read with. */
const planReply = defineResult('plan_reply', schemaOf(['name', 'overview', 'questions'], {}, true));

/**
 * The plan reply a run is asked for: a run that may not split is not told about tasks, one that is not a subtask is not
 * told about `needs`, `question`, `decisions` and `outOfScope`, and an answer-only reply is told of nothing but the reply and the escalation. The kind is the same.
 */
export function planReplyFor(shape: ReplyShape): ResultDefinition {
  const hidden = shape.answerOnly
    ? [...PLAN_KEYS, 'requirements']
    : [
        'name',
        'overview',
        'questions',
        ...(shape.split ? [] : SPLIT_KEYS),
        ...(shape.subtask ? [] : ['needs', ...STARTER_FIELDS]),
      ];
  return { ...planReply, schema: schemaOf(hidden, shape) };
}

/** A reply that holds a plan or tasks. */
export function replyHasPlan(reply: PlanReplyResult): boolean {
  return Boolean(reply.plan?.length || reply.tasks?.length);
}
