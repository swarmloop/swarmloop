import { HostUnavailable } from '../core/swarmloop-error';
import type { RunRepository } from '../history/run.repository';
import type { AgentDoor } from '../steps/shared/agent-door';
import { HopGate } from './hop-gate';
import type { RunGuards } from './run-guards';
import type { StartGate } from './start-gate';
import type { SubtaskPort } from './subtask-port';

describe('HopGate.askChain', () => {
  it("asking the chain while the model host does not answer keeps the refusal's SAME_INPUT wait and ends the drive with the outage line", async () => {
    const down = new HostUnavailable('api.anthropic.com', 'API Error: 502', '2026-01-01T00:05:00.000Z');
    const release = jest.fn();
    const runs = { findRun: async () => ({ key: 'PROJ-1' }), release } as unknown as RunRepository;
    const subtasks = { askUp: () => Promise.reject(down) } as unknown as SubtaskPort;
    const gate = new HopGate({} as StartGate, {} as RunGuards, runs, {} as AgentDoor, subtasks);

    const refusal = { message: 'same input', question: { from: 'plan', text: 'same input' }, startLevel: 1 };
    await expect(gate.askChain('PROJ-1', refusal as never)).resolves.toEqual({ message: down.message });
    expect(release).not.toHaveBeenCalled();
  });
});
