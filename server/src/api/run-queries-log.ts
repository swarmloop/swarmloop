import { NotFoundException } from '@nestjs/common';
import type { SwarmloopEnv } from '../config/env';
import { pipelineStepOf } from '../contract/steps';
import { OUTPUT_STEPS, stepOutput, stepOutputPath } from '../core/attempt-output';
import { redact } from '../core/redact';
import type { RunEntity, StepStatEntity } from '../history/entities';

/** An attempt is known when a stored stat of this step (or its code-review parent) or the active attempt names it. */
function knownAttempt(run: RunEntity, stats: StepStatEntity[], step: string, attempt: string): boolean {
  const owner = pipelineStepOf(step);
  return (
    stats.some((stat) => stat.attemptId === attempt && (stat.step === step || stat.step === owner)) ||
    (run.activeAttempt === attempt && (run.currentStep === step || run.currentStep === owner))
  );
}

/**
 * The raw log of one attempt of a step, redacted. The step and attempt are checked against the list and the history
 * before a path is built, so raw input never forms one.
 */
export async function readStepLog(
  run: RunEntity,
  stats: () => Promise<StepStatEntity[]>,
  dir: string,
  env: SwarmloopEnv,
  step: string,
  attempt: string | null,
): Promise<string> {
  if (!OUTPUT_STEPS.includes(step)) {
    throw new NotFoundException(`${step} has no log`);
  }
  if (attempt && !knownAttempt(run, await stats(), step, attempt)) {
    throw new NotFoundException(`${attempt} is not an attempt of ${step}`);
  }
  if (!stepOutputPath(dir, run.key, step, attempt)) {
    throw new NotFoundException(`${step} has no log`);
  }
  return redact(stepOutput(dir, run.key, step, attempt), env);
}
