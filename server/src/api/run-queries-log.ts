import { NotFoundException } from '@nestjs/common';
import type { AppConfig } from '../config/env';
import { pipelineStepOf } from '../contract/steps';
import { OUTPUT_STEPS, stepOutput, stepOutputPath } from '../core/attempt-output';
import { redact } from '../core/redact';
import type { RunEntity, StepStatEntity } from '../history/entities';
import type { RunRepository } from '../history/run.repository';
import type { VisitRepository } from '../history/visit.repository';
import { root } from '../history/run-paths';
import { requireRun } from './run-queries-run';

/** An attempt is known when a stored stat of this step (or its code-review parent) or the active attempt names it. */
function knownAttempt(run: RunEntity, stats: StepStatEntity[], step: string, attempt: string): boolean {
  const owner = pipelineStepOf(step);
  return (
    stats.some((stat) => stat.attemptId === attempt && (stat.step === step || stat.step === owner)) ||
    (run.activeAttempt === attempt && (run.currentStep === step || run.currentStep === owner))
  );
}

/**
 * The raw log of one attempt of a step, redacted. The run, step and attempt are checked against the list and the history
 * before a path is built, so raw input never forms one.
 */
export async function readStepLog(
  runs: RunRepository,
  visits: VisitRepository,
  config: AppConfig,
  key: string,
  step: string,
  attempt: string | null,
): Promise<string> {
  const run = await requireRun(runs, key);
  if (!OUTPUT_STEPS.includes(step)) {
    throw new NotFoundException(`${step} has no log`);
  }
  if (attempt && !knownAttempt(run, await visits.listStats(run.id), step, attempt)) {
    throw new NotFoundException(`${attempt} is not an attempt of ${step}`);
  }
  const dir = root(config);
  if (!stepOutputPath(dir, run.key, step, attempt)) {
    throw new NotFoundException(`${step} has no log`);
  }
  return redact(stepOutput(dir, run.key, step, attempt), config.env);
}
