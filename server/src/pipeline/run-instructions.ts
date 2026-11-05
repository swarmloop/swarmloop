import type { AppConfig } from '../config/env';
import { liveLogBody } from '../agent/live-output';
import type { RunEntity } from '../history/entities';
import type { DocumentRepository } from '../history/document.repository';
import type { RunRepository } from '../history/run.repository';
import { root } from '../history/run-paths';
import { renderProjects, storedProjects } from '../steps/prepare/checkout-path';
import type { StepRegistry } from '../steps/step.registry';
import { joinPrompt, withInstructions } from '../steps/plan/plan-record';
import type { StepName } from '../contract/steps';

export class RunInstructions {
  constructor(
    protected readonly runs: RunRepository,
    protected readonly documents: DocumentRepository,
    protected readonly registry: StepRegistry,
    protected readonly config: AppConfig,
  ) {}

  savedOutput(run: RunEntity): string {
    return liveLogBody(root(this.config), run.key, run.currentStep);
  }

  async pinProjects(key: string, names: string[]): Promise<void> {
    const body = renderProjects(names);
    const existing = await this.runs.findRun(key);
    if (existing) {
      if (!storedProjects(existing.projects).length) {
        existing.projects = body;
        await this.runs.saveRun(existing);
      }
      return;
    }
    const created = await this.runs.openWaiting(key, '');
    created.targetPath = null;
    created.projects = body;
    await this.runs.saveRun(created);
  }

  async storeInstructions(run: RunEntity, step: StepName, text: string): Promise<string> {
    const prompt = joinPrompt(run.prompt, text);
    run.prompt = prompt;
    await this.runs.saveRun(run);
    await this.documents.putDocument(run, `instructions:${step}`, text);
    const target = this.registry.get(step);
    if (target?.acceptsPrompt) {
      return prompt;
    }
    const body = await this.documents.latestBody(run.key, 'requirements');
    if (body) {
      const revise = target?.revisesRequirements === true;
      await this.documents.putDocument(run, 'requirements', withInstructions(body, text, revise));
    }
    return prompt;
  }
}
