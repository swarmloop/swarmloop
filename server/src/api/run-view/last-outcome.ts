import { stepState } from '../../contract/step-state';

/**
 * What a step that will run again did last, in a few words: `<how it sent the work back> → implement` for a return, else
 * the word of the status it had before the relaunch, in lower case, such as `done`. `before` is that status; `sentBack`
 * gives the return in words when there is one. Nothing for a step that is not `again`.
 */
export function lastOutcome(
  status: string,
  before: string,
  sentBack: () => string | undefined,
): { lastOutcome: string } | Record<string, never> {
  if (status !== 'again') return {};
  return {
    lastOutcome:
      before === 'returned'
        ? `${sentBack() ?? 'sent work back'} → implement`
        : stepState(before, null).word.toLowerCase(),
  };
}
