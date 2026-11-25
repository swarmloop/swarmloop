import type { RunEntity } from '../history/entities';
import type { DocumentRepository } from '../history/document.repository';
import type { RunRepository } from '../history/run.repository';
import { renderProjects, storedProjects } from '../config/checkout-path';
import type { StepRegistry } from '../steps/step.registry';
import { joinPrompt, withInstructions } from '../steps/plan/plan-record';
import type { StepName } from '../contract/steps';

export class RunInstructions {
  constructor(
    protected readonly runs: RunRepository,
    protected readonly documents: DocumentRepository,
    protected readonly registry: StepRegistry,
  ) {}

  async pinProjects(key: string, names: string[]): Promise<void> {
    const body = renderProjects(names);
    const existing = await this.runs.findRun(key);
    if (existing) {
      await this.runs.change(key, (row) => {
        if (!storedProjects(row.projects).length) row.projects = body;
      });
      return;
    }
    await this.runs.openWaiting(key, '');
    await this.runs.change(key, (created) => {
      created.targetPath = null;
      created.projects = body;
    });
  }

  async storeInstructions(run: RunEntity, step: StepName, text: string): Promise<string> {
    let prompt = '';
    const stored = await this.runs.change(run.key, (row) => {
      prompt = joinPrompt(row.prompt, text);
      row.prompt = prompt;
    });
    await this.documents.putDocument(stored, `instructions:${step}`, text);
    const target = this.registry.get(step);
    if (target?.capabilities.prompt) {
      return prompt;
    }
    const body = await this.documents.latestBody(run.key, 'requirements');
    if (body) {
      const revise = target?.capabilities.revisesRequirements === true;
      await this.documents.putDocument(stored, 'requirements', withInstructions(body, text, revise));
    }
    return prompt;
  }
}
