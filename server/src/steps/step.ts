import type { DocumentRepository } from '../history/document.repository';
import type { PipelineResult, StepOptions } from '../core/pipeline-result';
import type { StepName } from '../contract/steps';
import type { SwarmloopEnv } from '../config/env';
import type { Charge } from '../agent/spend';
import type { ModelPrice } from '../agent/limits';
import { readPlan } from './plan/plan-record';

export interface Step {
  readonly name: StepName;
  readonly usesModel: boolean;
  /** Takes instructions as its prompt. */
  readonly acceptsPrompt?: boolean;
  /** Takes a checkout path. */
  readonly acceptsPath?: boolean;
  /** Takes the project list when it starts. */
  readonly acceptsProjects?: boolean;
  /** Instructions given to this step revise the requirements document. */
  readonly revisesRequirements?: boolean;
  /** Prices a run abandoned in this step. Without it, the model stream is priced. */
  charge?(key: string, env: SwarmloopEnv, prices: Record<string, ModelPrice>): Promise<Charge | null>;
  missingInput(key: string, options: StepOptions): Promise<string | null>;
  execute(key: string, options: StepOptions): Promise<PipelineResult>;
}

/** The document kind when it is not stored yet, or null when it is. */
export async function requiredDocument(
  documents: DocumentRepository,
  key: string,
  kind: string,
): Promise<string | null> {
  return (await documents.hasDocument(key, kind)) ? null : kind;
}

/** `plan` when the requirements record holds no plan, or null when it does. */
export async function storedPlan(documents: DocumentRepository, key: string): Promise<string | null> {
  const plan = readPlan(await documents.latestBody(key, 'requirements'));
  return plan ? null : 'plan';
}
