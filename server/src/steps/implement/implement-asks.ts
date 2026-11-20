import type { RunEntity } from '../../history/entities';
import { isSubtask } from '../../contract/subtask';
import type { ImplementationResult } from '../../agent-result/definitions/implementation';
import type { ModelStepContext } from '../model-step-context';
import { ARTIFACTS } from '../contract/artifacts';
import type { StarterExchange, StarterOutcome } from '../shared/starter-exchange';
import { withAssumed } from './implement-question';

/**
 * What the server checks on an implement answer after its schema: it changed something, or a subtask waits for a
 * sibling, or the step asks or hands something back, and what a subtask decided is about its own items.
 */
export function implementErrors(
  run: RunEntity,
  value: ImplementationResult,
  mayQuestion: boolean,
  exchange: StarterExchange,
  contract: string | null,
): string[] {
  const errors = exchange.check(run, value, contract);
  const asking = mayQuestion && Boolean(value.question?.trim() || value.outOfScope?.length);
  if (value.implementation.length === 0 && !asking && !(isSubtask(run) && value.needs?.length)) {
    errors.push('implementation: must list what you changed');
  }
  return errors;
}

/**
 * What an implement answer hands back, acted on in the one place: the result of a visit that waits (for a sibling,
 * for the planner, for the planner of the parent), or the choices the step made itself.
 */
export function implementExchange(
  exchange: StarterExchange,
  ctx: ModelStepContext,
  visit: { answered: boolean; mayAsk: boolean },
  value: ImplementationResult,
): Promise<StarterOutcome> {
  const needsOutputs = [{ artifact: ARTIFACTS.implementationResult, value }];
  return exchange.act(ctx, value, { step: 'implement', route: 'chat', outputs: [], needsOutputs, ...visit });
}

/** The handoff text with one `assumed:` line after it for each choice the step made itself. */
export function withAssumptions(handoff: string, choices: readonly string[]): string {
  return choices.reduce(withAssumed, handoff);
}
