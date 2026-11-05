import { existsSync, realpathSync, statSync } from 'fs';
import type { AppConfig } from '../config/env';
import { overSpend } from '../agent/limits';
import type { RunStop } from '../agent/run-stop';
import type { DocumentRepository } from '../history/document.repository';
import type { RunRepository } from '../history/run.repository';
import type { VisitRepository } from '../history/visit.repository';
import type { Clock } from '../core/clock';
import type { ProjectAppendService } from '../steps/prepare/project-append.service';
import type { StepRegistry } from '../steps/step.registry';
import type { PipelineResult, StepOptions } from '../core/pipeline-result';
import {
  continuesSameStep,
  autoContinues,
  countedVisits,
  continues,
  failedLaunches,
  isStep,
  loopMark,
  settle,
} from '../core/pipeline-result';
import type { StepName } from '../contract/steps';
import { STEPS } from '../contract/steps';
import type { Step } from '../steps/step';

const HOP_LIMIT = STEPS.length * 3;

export class RunDriver {
  constructor(
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly registry: StepRegistry,
    private readonly config: AppConfig,
    private readonly visits: VisitRepository,
    private readonly runStop: RunStop,
    private readonly clock: Clock,
    private readonly projects: ProjectAppendService,
  ) {}

  async savedStep(
    key: string,
    keyError: (key: string) => PipelineResult | null,
    busy: (key: string) => Promise<boolean>,
  ): Promise<{ step: StepName } | PipelineResult> {
    const invalid = keyError(key);
    if (invalid) return invalid;
    if (await busy(key)) return { exitCode: 1, message: `${key} is already running` };
    const existing = await this.runs.findRun(key);
    if (existing?.status === 'done') return { exitCode: 0, message: `${key} is done` };
    const step = existing?.currentStep ?? STEPS[0];
    if (!isStep(step)) return { exitCode: 1, message: `${step} is unknown` };
    return { step };
  }

  async drive(name: StepName, key: string, options: StepOptions): Promise<PipelineResult> {
    let step = name;
    let stepOptions = options;
    let manual = options.auto !== true;
    let result: PipelineResult = { exitCode: 0, message: `${key} started` };
    let ran = false;
    for (let hop = 0; hop < HOP_LIMIT; hop += 1) {
      const blocked = await this.spendStop(key, step);
      if (blocked) {
        return { exitCode: ran ? 0 : 1, message: blocked };
      }
      result = await this.execute(step, key, stepOptions);
      ran = true;
      if (manual) {
        await this.markLoop(key);
        manual = false;
      }
      if (this.runStop.halted(key)) {
        return result;
      }
      const run = await this.runs.findRun(key);
      const mark = loopMark(await this.documents.latestBody(key, 'loop_mark'));
      const stats = run ? await this.visits.listStats(run.id) : [];
      const env = this.config.env;
      if (result.resume && run?.status === 'waiting' && run.currentStep === step) {
        stepOptions = { auto: true };
        continue;
      }
      if (
        run?.status === 'failed' &&
        run.currentStep === step &&
        step !== 'done' &&
        failedLaunches(stats, step, mark) < env.MAX_LAUNCHES
      ) {
        stepOptions = { ...stepOptions, auto: true };
        continue;
      }
      const next = continues(step, run);
      const visits = next ? countedVisits(stats, next, mark) : 0;
      const following = autoContinues(step, run, visits, env.MAX_RETURNS);
      if (!following) {
        return result;
      }
      step = following;
      stepOptions = { auto: true };
    }
    return result;
  }

  async spendStop(key: string, step: StepName): Promise<string | null> {
    const existing = await this.runs.findRun(key);
    if (!existing || !overSpend(existing.spentUsd, this.config.env.MAX_RUN_USD)) {
      return null;
    }
    const stats = await this.visits.listStats(existing.id);
    const last = [...stats].reverse().find((item) => item.step === step)?.status ?? null;
    if (continuesSameStep(existing.status, existing.currentStep, step, last)) {
      return null;
    }
    const message = `${key} is over the spend limit. ${step} was not started`;
    await this.documents.putDocument(existing, 'spend', `${message}\n`);
    return message;
  }

  async markLoop(key: string): Promise<void> {
    const run = await this.runs.findRun(key);
    if (!run) {
      return;
    }
    const stats = await this.visits.listStats(run.id);
    const mark = stats.reduce((max, item) => Math.max(max, item.id), 0);
    await this.documents.putDocument(run, 'loop_mark', `${mark}\n`);
  }

  async execute(name: StepName, key: string, options: StepOptions): Promise<PipelineResult> {
    const pendingError = await this.applyPending(key);
    if (pendingError) {
      return { exitCode: 1, message: pendingError };
    }
    const step = this.registry.get(name);
    if (step) {
      return step.execute(key, options);
    }
    const prior = await this.runs.findRun(key);
    const previousStep = prior?.currentStep ?? name;
    const previousStatus = prior?.status ?? 'waiting';
    const run = await this.runs.begin(key, name);
    if (options.path) {
      run.targetPath = realpathSync(options.path);
    }
    const settled = settle(previousStep, previousStatus, name, 'blocked');
    run.status = settled.status;
    run.currentStep = settled.currentStep;
    run.ownerPid = null;
    await this.runs.saveRun(run);
    const line = `${this.clock.iso()} ${name} not implemented`;
    return { exitCode: 1, message: line };
  }

  async applyPending(key: string): Promise<string | null> {
    try {
      await this.projects.flush(key);
      return null;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'repository failed';
      const run = await this.runs.findRun(key);
      if (run && run.status !== 'running') {
        run.status = 'failed';
        run.ownerPid = null;
        await this.runs.saveRun(run);
        await this.documents.putDocument(run, 'error', `${message}\n`);
      }
      return message;
    }
  }

  async missingInput(name: StepName, key: string, options: StepOptions): Promise<string | null> {
    return this.registry.get(name)?.missingInput(key, options) ?? null;
  }

  async start(
    name: StepName,
    key: string,
    options: StepOptions,
    busy: (key: string) => Promise<boolean>,
  ): Promise<PipelineResult> {
    const flagged = flagError(this.registry.get(name), options);
    if (flagged) return { exitCode: 1, message: flagged };
    const pathError = targetError(options.path);
    if (pathError) return { exitCode: 1, message: pathError };
    const missing = await this.missingInput(name, key, options);
    if (missing) return { exitCode: 1, message: `${missing} is missing` };
    if (await busy(key)) return { exitCode: 1, message: `${key} is already running` };
    const blocked = await this.spendStop(key, name);
    if (blocked) return { exitCode: 1, message: blocked };
    return this.execute(name, key, options);
  }
}

function flagError(step: Step | null, options: StepOptions): string | null {
  if ((options.prompt !== undefined || options.promptFile !== undefined) && !step?.acceptsPrompt)
    return 'prompt is only valid for requirements';
  if (options.path && !step?.acceptsPath) return 'path is only valid for code-review';
  return null;
}

function targetError(path: string | undefined): string | null {
  if (path === undefined) return null;
  if (!existsSync(path) || !statSync(path).isDirectory()) return 'path is not a directory';
  return null;
}
