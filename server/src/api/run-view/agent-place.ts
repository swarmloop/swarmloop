import type { ContainerGate } from '../../sandbox/container-gate';
import type { FlowView } from '../../contract/api';

type AgentWait = ReturnType<ContainerGate['agentWait']>;

/** The chips of the steps whose agent waits for a free place read `waiting` with the gate's words. */
export function withPlaceChips(phases: FlowView['phases'], wait: AgentWait): FlowView['phases'] {
  if (wait.steps.length === 0) return phases;
  return phases.map((phase) => ({
    ...phase,
    steps: phase.steps.map((step) =>
      wait.steps.includes(step.name) ? { ...step, status: 'waiting', note: wait.text } : step,
    ),
  }));
}
