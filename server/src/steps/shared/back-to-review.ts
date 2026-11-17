import type { FlowRepository } from '../../history/flow.repository';
import type { StepContext } from '../base-step';
import type { StepResult } from '../contract/step-contract';

/** The review or the CI result does not match these files or this generation: review again, then publish. */
export async function jumpBackToReview(ctx: StepContext, flows: FlowRepository, reason: string): Promise<StepResult> {
  const { opened } = ctx;
  await flows.noteFlow(opened.run.key, ['code-review', 'ci'], 'code-review');
  const line = `${opened.startedAt} ${reason}: back to code-review`;
  return { route: { to: 'jump', step: 'code-review' }, summary: line, outputs: [] };
}
