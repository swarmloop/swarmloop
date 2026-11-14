import 'reflect-metadata';
import { mkdirSync } from 'fs';
import { join } from 'path';
import type { TestingModule } from '@nestjs/testing';
import type { StepKernel } from '../steps/step-kernel';
import { BaseStep, type StepContext } from '../steps/base-step';
import type { StepCapabilities, StepResult } from '../steps/contract/step-contract';
import type { Step, StepSnapshot } from '../steps/step';
import type { StepName } from '../contract/steps';
import type { StepOptions } from '../core/pipeline-result';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';

export class ScriptedFakeAgentRunner {
  readonly steps: string[] = [];

  run(step: string): Promise<void> {
    this.steps.push(step);
    return Promise.resolve();
  }
}

export class FakeCodeHost {
  open(): Promise<{ url: string }> {
    return Promise.resolve({ url: 'https://code.example/test/merge_requests/1' });
  }
}

export class ScriptedStep extends BaseStep<Record<string, never>> {
  readonly inputs = {};
  readonly outputs = [];
  override readonly usesModel = false;
  override readonly capabilities: StepCapabilities;

  constructor(
    readonly name: StepName,
    kernel: StepKernel,
    private readonly runner: { run(input: { step: string }): Promise<void> },
    private readonly codeHost: FakeCodeHost,
  ) {
    super(kernel);
    this.capabilities = { prompt: name === 'requirements', projects: name === 'prepare' };
  }

  override missingInput(): Promise<null> {
    return Promise.resolve(null);
  }

  protected async work(_input: object, context: StepContext): Promise<StepResult> {
    await this.runner.run({ step: this.name });
    if (this.name === 'merge-request') await this.codeHost.open();
    return { route: { to: 'next' }, summary: `${context.opened.startedAt} complete`, outputs: [] };
  }
}

/**
 * A real step run by the test app: the worktrees it mounts and the requirements the scripted requirements step does
 * not write are seeded when the step is asked for them.
 */
export function seededStep(real: Step, module: TestingModule, root: string): Step {
  const seeded = (key: string): void => {
    mkdirSync(join(root, 'worktrees', key), { recursive: true });
  };
  const withRequirements = async (key: string): Promise<void> => {
    const documents = module.get(DocumentRepository);
    const run = await module.get(RunRepository).findRun(key);
    if (run && (await documents.latestBody(key, 'requirements')) === null) {
      await documents.putDocument(run, 'requirements', '{"prompt":"Ship the field"}\n');
    }
  };
  return Object.create(real, {
    missingInput: {
      value: (key: string, stepOptions: StepOptions) => {
        seeded(key);
        return real.missingInput(key, stepOptions);
      },
    },
    execute: {
      value: async (key: string, stepOptions: StepOptions, snapshot?: StepSnapshot) => {
        seeded(key);
        await withRequirements(key);
        return real.execute(key, stepOptions, snapshot);
      },
    },
  }) as Step;
}
