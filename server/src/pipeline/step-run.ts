import type { RunEntity } from '../history/entities';
import type { HistoryService } from '../history/history.service';
import type { VisitDraft } from '../history/visit';
import { snapshotRun } from '../git/worktree-snapshot';
import type { PipelineResult } from '../core/pipeline-result';
import { settle } from '../core/pipeline-result';
import type { StepName } from '../contract/steps';
import type { Clock } from '../core/clock';

export interface OpenedStep {
  run: RunEntity;
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

export async function openStep(
  history: HistoryService,
  clock: Clock,
  key: string,
  step: StepName,
): Promise<OpenedStep> {
  const started = clock.now();
  const prior = await history.findRun(key);
  return {
    run: await history.begin(key, step),
    prior,
    previousStep: prior?.currentStep ?? step,
    previousStatus: prior?.status ?? 'waiting',
    started,
    startedAt: new Date(started).toISOString(),
  };
}

export async function closeStep(input: {
  history: HistoryService;
  clock: Clock;
  run: RunEntity;
  previousStep: string;
  previousStatus: string;
  step: StepName;
  outcome: 'ok' | 'failed' | 'blocked' | 'waiting';
  visit: VisitDraft;
  line: string;
  exitCode: number;
  moveTo?: StepName;
}): Promise<PipelineResult> {
  const phases = await input.history.activePhases(input.run.id);
  const settled = settle(input.previousStep, input.previousStatus, input.step, input.outcome, input.moveTo, phases);
  input.run.status = settled.status;
  input.run.currentStep = settled.currentStep;
  input.run.ownerPid = null;
  if (input.outcome === 'failed' || input.outcome === 'blocked') {
    const docs = input.visit.documents ?? (input.visit.document ? [input.visit.document] : []);
    if (!docs.some((document) => document.kind === 'error')) {
      docs.push({ kind: 'error', fileName: '', body: `${failureText(input.line)}\n` });
    }
    input.visit.documents = docs;
    input.visit.document = null;
  }
  await input.history.finishVisit(input.run, input.visit);
  input.run.stepStartedAt = null;
  await input.history.saveRun(input.run);
  await input.history.appendProgress(input.run.key, input.line);
  await snapshotRun(input.history, input.clock, input.run, input.step);
  return { exitCode: input.exitCode, message: input.line };
}
