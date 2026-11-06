import type { StepOptions } from '../core/pipeline-result';
import type { Step } from '../steps/step';

export function flagError(step: Step | null, options: StepOptions): string | null {
  if ((options.prompt !== undefined || options.promptFile !== undefined) && !step?.capabilities.prompt)
    return 'prompt is only valid for requirements';
  if (options.path && !step?.capabilities.path) return 'path is only valid for code-review';
  return null;
}
