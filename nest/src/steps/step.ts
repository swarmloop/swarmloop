import { HistoryService } from '../history/history.service';
import { PipelineResult, StepName, StepOptions } from '../pipeline/pipeline-result';
import { readPlan } from './plan/plan-record';

export interface Step {
  readonly name: StepName;
  readonly usesModel: boolean;
  missingInput(key: string, options: StepOptions): Promise<string | null>;
  execute(key: string, options: StepOptions): Promise<PipelineResult>;
}

/** The document kind when it is not stored yet, or null when it is. */
export async function requiredDocument(history: HistoryService, key: string, kind: string): Promise<string | null> {
  return (await history.hasDocument(key, kind)) ? null : kind;
}

/** `plan` when the requirements record holds no plan, or null when it does. */
export async function storedPlan(history: HistoryService, key: string): Promise<string | null> {
  const plan = readPlan(await history.latestBody(key, 'requirements'));
  return plan ? null : 'plan';
}
