import { ERROR_CODES } from '../contract/error-codes';
import { HostUnavailable } from '../core/swarmloop-error';
import type { RunRepository } from '../history/run.repository';
import type { AgentDoor } from '../steps/shared/agent-door';
import { HopGate } from './hop-gate';
import type { RunGuards } from './run-guards';
import type { StartGate } from './start-gate';
import type { SubtaskPort } from './subtask-port';

describe('HopGate.askChain', () => {
  const refusal = { message: 'same input', question: { from: 'plan', text: 'same input' }, startLevel: 1 };
  const gateOf = (status: string, askUp: SubtaskPort['askUp'], release = jest.fn()) => {
    const runs = { findRun: async () => ({ key: 'PROJ-1', status }), release } as unknown as RunRepository;
    const gate = new HopGate({} as StartGate, {} as RunGuards, runs, {} as AgentDoor, { askUp } as SubtaskPort);
    return { gate, release };
  };

  it("asking the chain while the model host does not answer leaves the run waiting for the host with its next try and ends the drive with the host's words", async () => {
    const down = new HostUnavailable('api.anthropic.com', 'API Error: 502', '2026-01-01T00:05:00.000Z');
    const { gate, release } = gateOf('waiting', () => Promise.reject(down));

    await expect(gate.askChain('PROJ-1', refusal as never)).resolves.toEqual({ message: down.message });
    expect(release).toHaveBeenCalledWith(expect.objectContaining({ key: 'PROJ-1' }), {
      status: 'waiting',
      reason: {
        code: ERROR_CODES.HOST_UNAVAILABLE,
        message: down.message,
        retryAt: '2026-01-01T00:05:00.000Z',
        refusedStart: true,
      },
      stepStartedAt: null,
    });
  });

  it('writes no wait for an outage when the run is not waiting', async () => {
    const down = new HostUnavailable('api.anthropic.com', 'API Error: 502', '2026-01-01T00:05:00.000Z');
    const { gate, release } = gateOf('running', () => Promise.reject(down));

    await expect(gate.askChain('PROJ-1', refusal as never)).resolves.toEqual({ message: down.message });
    expect(release).not.toHaveBeenCalled();
  });

  it('goes on from an answer as before', async () => {
    const { gate, release } = gateOf('waiting', async () => ({ answer: 'yes', level: 2 }) as never);

    await expect(gate.askChain('PROJ-1', refusal as never)).resolves.toEqual({
      again: { auto: true, startBy: 'planner', level: 2 },
    });
    expect(release).not.toHaveBeenCalled();
  });
});
