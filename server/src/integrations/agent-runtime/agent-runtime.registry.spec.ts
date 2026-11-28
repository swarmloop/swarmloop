import { paidUseUnseenConnections, runtimeFor, runtimeForCommand } from './agent-runtime.registry';

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

  it('declares the context window of each known Claude model and none for an unknown one', () => {
    expect(runtimeFor('claude').contextTokens('claude-opus-5-5')).toBe(1_000_000);
    expect(runtimeFor('claude').contextTokens('claude-sonnet-5-5')).toBe(1_000_000);
    expect(runtimeFor('claude').contextTokens('claude-unknown')).toBeNull();
  });

  it('declares no context window for codex and cursor models', () => {
    expect(runtimeFor('codex').contextTokens('gpt-5')).toBeNull();
    expect(runtimeFor('cursor').contextTokens('grok-4.7')).toBeNull();
  });

  it('lists the connections of the runtimes whose paid use it cannot see', () => {
    expect(paidUseUnseenConnections().map((connection) => connection.id)).toEqual(['cursor', 'codex']);
  });
});
