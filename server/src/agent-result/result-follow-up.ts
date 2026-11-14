import { RESULT_AS_BEFORE } from './result-prompt';

/** The one follow-up for an answer the server could not accept: every error, and nothing about the schema or the skill. */
export function resultFollowUp(errors: string[]): string {
  return [
    'The result block of your last answer was not accepted:',
    ...errors.map((error) => `- ${error}`),
    '',
    `Send the result block again and change nothing else. ${RESULT_AS_BEFORE}`,
  ].join('\n');
}
