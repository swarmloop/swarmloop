import type { DocumentRepository } from '../history/document.repository';
import type { PipelineResult, StepOptions } from '../core/pipeline-result';
import type { StepName } from '../contract/steps';
import type { RunEntity } from '../history/entities';
import type { SwarmloopEnv } from '../config/env';
import { currentPlan } from './shared/current-plan';
import type { StepCapabilities, StepDescriptor } from './contract/step-contract';

export type StepSnapshot = (run: RunEntity, step: StepName) => Promise<void>;

export interface Step {
  readonly name: StepName;
  readonly usesModel: boolean;
  /** Whether a start of the run launches an agent. Without it, `usesModel` says. */
  launchesAgent?(key: string): Promise<boolean>;
  readonly capabilities: StepCapabilities;
  describe(env: SwarmloopEnv): StepDescriptor;
  missingInput(key: string, options: StepOptions): Promise<string | null>;
  execute(key: string, options: StepOptions, snapshot?: StepSnapshot): Promise<PipelineResult>;
}

/** The document kind when it is not stored yet, or null when it is. */
export async function requiredDocument(
  documents: DocumentRepository,
  key: string,
  kind: string,
): Promise<string | null> {
  return (await documents.hasDocument(key, kind)) ? null : kind;
}

/** `plan` when the run holds no plan, or null when it does. */
export async function storedPlan(documents: DocumentRepository, key: string): Promise<string | null> {
  return (await currentPlan(documents, key)) ? null : 'plan';
}
