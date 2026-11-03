import { runtimeFor, runtimeForCommand } from './agent-runtime.registry';

describe('agent runtime registry', () => {
  it('resolves codex by name and by command', () => {
    expect(runtimeFor('codex').name).toBe('codex');
    expect(runtimeFor('codex').image).toBe('swarmloop-agent-codex');
    expect(runtimeForCommand('codex').command).toBe('codex');
  });
});
