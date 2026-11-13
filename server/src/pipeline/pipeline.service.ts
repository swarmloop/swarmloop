import { Injectable, OnApplicationBootstrap } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { RunStop } from '../agent/run-stop';
import type { RunEntity } from '../history/entities';
import { RunRepository } from '../history/run.repository';
import { DocumentRepository } from '../history/document.repository';
import { VisitRepository } from '../history/visit.repository';
import { SandboxService } from '../sandbox/sandbox.service';
import { Clock } from '../core/clock';
import { ProjectAppendService } from '../steps/prepare/project-append.service';
import { RequirementsStep } from '../steps/requirements/requirements.step';
import { StepRegistry } from '../steps/step.registry';
import { PipelineResult, isStep, StepOptions } from '../core/pipeline-result';
import { StepName } from '../contract/steps';
import { SwarmloopError } from '../core/swarmloop-error';
import { WorkspaceGuard } from './workspace-guard';
import { DiskGuard } from './disk-guard';
import { SubtaskPort } from './subtask-port';
import { RunDriver } from './run-driver';
import { RunInstructions } from './run-instructions';
import { Reconciler } from './reconciler';
import { RunLifecycle } from './run-lifecycle';
import { MergeRequestDrafts } from '../steps/merge-request/merge-request-draft';

@Injectable()
export class PipelineService implements OnApplicationBootstrap {
  private readonly instructions: RunInstructions;
  private readonly driver: RunDriver;
  private readonly lifecycle: RunLifecycle;

  constructor(
    private readonly runs: RunRepository,
    documents: DocumentRepository,
    visits: VisitRepository,
    private readonly requirements: RequirementsStep,
    private readonly registry: StepRegistry,
    sandbox: SandboxService,
    config: AppConfig,
    clock: Clock,
    private readonly runStop: RunStop,
    projects: ProjectAppendService,
    reconciler: Reconciler,
    workspace: WorkspaceGuard,
    disk: DiskGuard,
    subtasks: SubtaskPort,
    private readonly drafts: MergeRequestDrafts,
  ) {
    this.instructions = new RunInstructions(runs, documents, registry);
    this.driver = new RunDriver(
      runs,
      documents,
      registry,
      config,
      visits,
      runStop,
      clock,
      projects,
      workspace,
      disk,
      subtasks,
    );
    this.lifecycle = new RunLifecycle(
      runs,
      documents,
      registry,
      config,
      visits,
      runStop,
      clock,
      sandbox,
      requirements,
      this.driver,
      this.instructions,
      reconciler,
    );
  }

  onApplicationBootstrap(): Promise<void> {
    return this.lifecycle.onApplicationBootstrap();
  }

  async run(key: string, options: StepOptions = {}): Promise<PipelineResult> {
    const saved = await this.driver.savedStep(
      key,
      (value) => this.lifecycle.keyError(value),
      (value) => this.lifecycle.busy(value),
    );
    if ('exitCode' in saved) return saved;
    return this.start(saved.step, key, options);
  }

  async runThrough(key: string, options: StepOptions = {}): Promise<PipelineResult> {
    const saved = await this.driver.savedStep(
      key,
      (value) => this.lifecycle.keyError(value),
      (value) => this.lifecycle.busy(value),
    );
    if ('exitCode' in saved) return saved;
    return this.driver.drive(saved.step, key, options);
  }

  stop(key: string): Promise<PipelineResult> {
    return this.lifecycle.stop(key);
  }

  async replay(key: string, name: string, prompt: string): Promise<PipelineResult> {
    const invalid = this.lifecycle.keyError(key);
    if (invalid) return invalid;
    if (!isStep(name) || name === 'done') return { exitCode: 1, message: `${name} is unknown` };
    const text = prompt.trim();
    if (!text) return { exitCode: 1, message: 'prompt is missing' };
    const run = await this.runs.findRun(key);
    if (!run) return { exitCode: 1, message: `${key} is missing` };
    const stopped = await this.lifecycle.stopRunning(key, run);
    if (stopped) return stopped;
    const fresh = (await this.runs.findRun(key)) ?? run;
    const full = await this.instructions.storeInstructions(fresh, name, text);
    const failed = await this.backToDraft(fresh);
    if (failed) return failed;
    await this.runs.release(fresh, { status: 'waiting', currentStep: name });
    this.runStop.clear(key);
    return this.startDetached(key, this.registryPromptOptions(name, full));
  }

  /** Work resumes: the merge requests of the run are drafts again before it starts. */
  private async backToDraft(run: RunEntity): Promise<PipelineResult | null> {
    try {
      await this.drafts.backToDraft(run);
      return null;
    } catch (error) {
      return { exitCode: 1, message: error instanceof SwarmloopError ? error.message : 'merge request failed' };
    }
  }

  startDetached(key: string, options: StepOptions = {}, only?: StepName): Promise<PipelineResult> {
    return this.lifecycle.startDetached(key, options, only);
  }

  async fetch(key: string): Promise<PipelineResult> {
    const invalid = this.lifecycle.keyError(key);
    if (invalid) return invalid;
    if (!/^[A-Z][A-Z0-9]+-\d+$/.test(key)) return { exitCode: 1, message: `${key} is not a Jira key` };
    if (await this.lifecycle.busy(key)) return { exitCode: 1, message: `${key} is already running` };
    try {
      return await this.requirements.fetch(key);
    } catch (error) {
      const message = error instanceof SwarmloopError ? error.message : 'requirements failed';
      return { exitCode: 1, message };
    }
  }

  async step(name: string, key: string, options: StepOptions = {}): Promise<PipelineResult> {
    const invalid = this.lifecycle.keyError(key);
    if (invalid) return invalid;
    if (!isStep(name)) return { exitCode: 1, message: `${name} is unknown` };
    return this.start(name, key, options);
  }

  claimed(key: string): boolean {
    return this.lifecycle.claimed(key);
  }

  whenIdle(key: string): Promise<void> {
    return this.lifecycle.whenIdle(key);
  }

  private start(name: StepName, key: string, options: StepOptions): Promise<PipelineResult> {
    return this.driver.start(name, key, options, (value) => this.lifecycle.busy(value));
  }

  private registryPromptOptions(name: StepName, prompt: string): StepOptions {
    return this.registry.get(name)?.capabilities.prompt ? { prompt } : {};
  }
}
