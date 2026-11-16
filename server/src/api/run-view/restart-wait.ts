import type { FlowView } from '../../contract/api';
import type { RunEntity } from '../../history/run.entity';
import { recoveringSince } from '../../history/run-state';

/** While the server waits for the agent a dead process started, the chip of the current step reads `waiting` with the restart time. */
export function withRestartWait(phases: FlowView['phases'], run: RunEntity): FlowView['phases'] {
  const since = run.status === 'running' ? recoveringSince(run) : null;
  if (since === null) return phases;
  const restartedAt = new Date(since).toISOString();
  return phases.map((phase) => ({
    ...phase,
    steps: phase.steps.map((step) =>
      step.name === run.currentStep ? { ...step, status: 'waiting', restartedAt } : step,
    ),
  }));
}
