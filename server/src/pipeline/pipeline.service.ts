import { Injectable, OnModuleInit } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { RunStop } from '../agent/run-stop';
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
import { RunDriver } from './run-driver';
import { RunInstructions } from './run-instructions';
import { RunLifecycle } from './run-lifecycle';

@Injectable()
export class PipelineService implements OnModuleInit {
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
  ) {
    this.instructions = new RunInstructions(runs, documents, registry, config);
    this.driver = new RunDriver(runs, documents, registry, config, visits, runStop, clock, projects);
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
    );
  }

  onModuleInit(): Promise<void> {
    return this.lifecycle.onModuleInit();
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
    fresh.currentStep = name;
    fresh.status = 'waiting';
    fresh.ownerPid = null;
    await this.runs.saveRun(fresh);
    this.runStop.clear(key);
    return this.startDetached(key, this.registryPromptOptions(name, full));
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
