import { research } from '../../agent-result/definitions/research';
import { resultPromptFor } from '../../agent-result/result-prompt';

/** The prompt that finishes an interrupted research in the same chat. */
export function researchContinue(received: string | null): string {
  return [
    'You were interrupted before the summary. Finish this research. Do not start over.',
    resultPromptFor(research, received),
  ].join('\n');
}
