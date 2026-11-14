import type { RunEntity } from '../../history/entities';
import { isSubtask } from '../../contract/subtask';
import type { StepResult } from '../contract/step-contract';
import type { ImplementationResult } from '../../agent-result/definitions/implementation';
import { needsWait } from '../shared/needs';

/**
 * The result of an implement visit whose answer has `needs`: the subtask waits for a sibling task and nothing is
 * committed. Null for any other answer, and for a run that is not a subtask.
 */
export function implementNeedsWait(run: RunEntity, startedAt: string, value: ImplementationResult): StepResult | null {
  const needs = isSubtask(run) ? (value.needs ?? []) : [];
  return needs.length > 0 ? needsWait(startedAt, needs) : null;
}
