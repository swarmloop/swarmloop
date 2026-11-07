import type { FlowView } from '@contract/api';
import { actionsFor } from '@contract/run-state';
import type { RunState } from '@contract/run-state';

/** The flow after a command moved the run to `state`, until the next fetch brings the server's own view. */
export function inState(flow: FlowView, state: RunState): FlowView {
  return { ...flow, state, stateReason: null, actions: actionsFor(state) };
}
