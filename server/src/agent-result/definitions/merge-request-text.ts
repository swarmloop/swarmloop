import Joi from 'joi';
import { defineResult } from '../result-definition';

/** The text of a merge request, filled from the repository's template. */
export const mergeRequestText = defineResult(
  'merge_request_text',
  Joi.object({
    text: Joi.string()
      .required()
      .description(
        'The merge request text, the repository template filled in; tick a box only for what the run did and proved',
      ),
  }),
);
