import Joi from 'joi';
import { defineResult } from './result-definition';

export const FENCE = '```';

export const block = (value: unknown): string => `${FENCE}json\n${JSON.stringify(value)}\n${FENCE}`;

export const sample = defineResult(
  'sample',
  Joi.object({
    title: Joi.string().required().description('A short title'),
    items: Joi.array().items(Joi.string()).required().description('One entry per line'),
    decision: Joi.string().valid('ok', 'return').required().description('The verdict'),
    note: Joi.string().description('Anything else'),
    tasks: Joi.array().items(Joi.object({ id: Joi.string().required().description('The task id') })),
  }),
);
