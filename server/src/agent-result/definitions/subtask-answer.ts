import Joi from 'joi';
import { defineResult } from '../result-definition';

/** What the parent's planner hands back to a subtask that asked questions. */
export interface SubtaskAnswerResult {
  answer: string;
}

export const subtaskAnswer = defineResult(
  'subtask_answer',
  Joi.object({
    answer: Joi.string().required().description('The decisions the subtask follows, one for each question'),
  }),
);
