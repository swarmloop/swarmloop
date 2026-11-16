import type { ResultDefinition } from '../../agent-result/result-definition';
import { resultPromptFor } from '../../agent-result/result-prompt';

/** The prompt that finishes an interrupted research in the same chat; `asked` is the definition the step asked. */
export function researchContinue(asked: ResultDefinition): string {
  return [
    'You were interrupted before the summary. Finish this research. Do not start over.',
    resultPromptFor(asked, asked.name),
  ].join('\n');
}
