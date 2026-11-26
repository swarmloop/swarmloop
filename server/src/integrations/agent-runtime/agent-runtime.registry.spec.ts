import { runtimeFor, runtimeForCommand } from './agent-runtime.registry';

describe('agent runtime registry', () => {
  it('resolves codex by name and by command', () => {
    expect(runtimeFor('codex').name).toBe('codex');
    expect(runtimeFor('codex').component).toBe('agent-codex');
    expect(runtimeForCommand('codex').command).toBe('codex');
  });

  it('declares no prompt cache for codex and cursor', () => {
    expect(runtimeFor('codex').promptCache('gpt-5')).toBeNull();
    expect(runtimeFor('cursor').promptCache('grok-4.7')).toBeNull();
  });
});
