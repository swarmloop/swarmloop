import type { LimitState } from '../contract/run-state';
import type { RunEntity } from '../history/entities';
import type { FlowRepository } from '../history/flow.repository';
import { blockCode, writeRunState } from '../history/run-state';
import type { RunRepository } from '../history/run.repository';
import type { VisitRepository } from '../history/visit.repository';
import type { VisitDraft } from '../history/visit';
import { barrier } from '../core/barrier';
import type { PipelineResult } from '../core/pipeline-result';
import { settle } from '../core/pipeline-result';
import type { StepName } from '../contract/steps';
import type { Clock } from '../core/clock';
import { ARTIFACTS } from './contract/artifacts';

export interface OpenedStep {
  run: RunEntity;
  attemptId: string;
  prior: RunEntity | null;
  previousStep: string;
  previousStatus: string;
  started: number;
  startedAt: string;
}

function failureText(line: string): string {
  return line
    .split('\n')
    .map((item, index) => (index === 0 ? item.replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/, '') : item))
    .join('\n')
    .trim();
}

export async function openStep(runs: RunRepository, clock: Clock, key: string, step: StepName): Promise<OpenedStep> {
  const started = clock.now();
  const prior = await runs.findRun(key);
  const run = await runs.begin(key, step);
  return {
    run,
    attemptId: run.activeAttempt ?? '',
    prior,
    previousStep: prior?.currentStep ?? step,
    previousStatus: prior?.status ?? 'waiting',
    started,
    startedAt: new Date(started).toISOString(),
  };
}

/** The wait before a visit's first event: from the end of the visit before it. Null for the first visit of a run. */
export async function preparedMs(visits: VisitRepository, runId: number, startedAt: string): Promise<number | null> {
  const previous = (await visits.listStats(runId)).at(-1);
  return previous ? Math.max(0, Date.parse(startedAt) - Date.parse(previous.finishedAt)) : null;
}

export async function closeStep(input: {
  runs: RunRepository;
  visits: VisitRepository;
  flows: FlowRepository;
  root: string;
  clock: Clock;
  run: RunEntity;
  attemptId: string;
  previousStep: string;
  previousStatus: string;
  step: StepName;
  outcome: 'ok' | 'failed' | 'blocked' | 'waiting';
  visit: VisitDraft;
  line: string;
  exitCode: number;
  moveTo?: StepName;
  code?: string;
  limit?: LimitState;
}): Promise<PipelineResult> {
  const phases = await input.flows.activePhases(input.run.id);
  const settled = settle(input.previousStep, input.previousStatus, input.step, input.outcome, input.moveTo, phases);
  let error: string | null = null;
  if (input.outcome === 'failed' || input.outcome === 'blocked') {
    const docs = input.visit.documents ?? (input.visit.document ? [input.visit.document] : []);
    if (!docs.some((document) => document.kind === ARTIFACTS.error.kind)) {
      docs.push({ kind: ARTIFACTS.error.kind, fileName: '', body: `${failureText(input.line)}\n` });
    }
    input.visit.documents = docs;
    input.visit.document = null;
    error = docs.find((document) => document.kind === ARTIFACTS.error.kind)?.body ?? null;
  }
  const code =
    settled.status === 'blocked'
      ? (input.code ?? blockCode(settled.currentStep, error))
      : settled.status === 'waiting'
        ? input.code
        : null;
  writeRunState(input.run, {
    status: settled.status,
    currentStep: settled.currentStep,
    reason: code
      ? { code, message: failureText(input.line), ...(input.limit ? { limit: input.limit } : {}) }
      : undefined,
    facts: code ? { blockCode: code } : undefined,
  });
  await barrier('before-finalize');
  await input.visits.finalize(input.attemptId, input.run, input.visit);
  await barrier('after-finalize');
  input.runs.notify(input.run.key);

  return { exitCode: input.exitCode, message: input.line };
}
