import type { DocumentEntity, RunEntity, StepStatEntity } from '../../history/entities';
import { isLoopStep } from '../../core/pipeline-result';
import { STEPS } from '../../contract/steps';
import type { StepName } from '../../contract/steps';

export function stepStatus(name: string, run: RunEntity, stat: StepStatEntity | undefined): string {
  if (name === 'done') {
    return run.status === 'done' ? 'done' : 'idle';
  }
  if (stat?.status === 'skipped') {
    return 'skipped';
  }
  if (name === run.currentStep) {
    return run.status === 'done' ? 'done' : run.status;
  }
  if (isLoopStep(name) && stat?.status === 'waiting') {
    return 'failed';
  }
  const current = STEPS.indexOf(run.currentStep as StepName);
  const index = STEPS.indexOf(name as StepName);
  if (index < current || stat) {
    return 'done';
  }
  return 'idle';
}

export function latest(documents: DocumentEntity[], kind: string): string | null {
  const found = [...documents].reverse().find((document) => document.kind === kind);
  return found?.body ?? null;
}
