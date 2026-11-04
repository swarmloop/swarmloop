import { CLAUDE_KEY_PLACEHOLDER, CLAUDE_OAUTH_PLACEHOLDER } from '../integrations/agent-runtime/claude/claude.runtime';
import { CODEX_KEY_PLACEHOLDER } from '../integrations/agent-runtime/codex/codex.runtime';
import type { EgressPolicy } from './egress';
import { EGRESS_API } from './egress';
import { withEgress } from './egress-launch';

function fakeEgress() {
  const policies: EgressPolicy[] = [];
  const released: string[] = [];
  return {
    policies,
    released,
    egress: {
      lease: jest.fn((policy: EgressPolicy) => {
        policies.push(policy);
        return Promise.resolve({ ip: '198.18.4.4', release: () => released.push('198.18.4.4') });
      }),
    },
  };
}

describe('withEgress', () => {
  it('keeps a launch without hosts off every network', async () => {
    const { egress } = fakeEgress();
    const launch = { runtime: 'claude' as const, allowHosts: [], command: ['claude'], env: [] };
    expect((await withEgress(egress, launch)).launch).toBe(launch);
    expect(egress.lease).not.toHaveBeenCalled();
  });

  it('keeps a launch that names a local host on the local network', async () => {
    const { egress } = fakeEgress();
    const launch = { runtime: 'claude' as const, allowHosts: ['host.docker.internal:11434'], command: ['claude'] };
    expect((await withEgress(egress, launch)).launch.egress).toBeUndefined();
  });

  it('gives Claude a placeholder API key and the proxy the real one', async () => {
    const { egress, policies } = fakeEgress();
    const { launch, release } = await withEgress(egress, {
      runtime: 'claude' as const,
      allowHosts: ['api.anthropic.com', 'registry.npmjs.org', 'api.anthropic.com'],
      command: ['claude', '--print', 'hi'],
      env: [{ name: 'ANTHROPIC_API_KEY', value: 'sk-ant-real' }],
    });
    expect(launch.egress).toEqual({ ip: '198.18.4.4' });
    expect(launch.env).toEqual([
      { name: 'ANTHROPIC_API_KEY', value: CLAUDE_KEY_PLACEHOLDER },
      { name: 'ANTHROPIC_BASE_URL', value: EGRESS_API },
      { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '1' },
    ]);
    expect(JSON.stringify(launch)).not.toContain('sk-ant-real');
    expect(policies[0]).toEqual({
      hosts: ['api.anthropic.com', 'registry.npmjs.org'],
      api: { upstream: 'https://api.anthropic.com', header: 'x-api-key', value: 'sk-ant-real' },
    });
    expect(launch.command).toEqual(['claude', '--print', 'hi']);
    expect(typeof release).toBe('function');
  });

  it('gives Claude a placeholder subscription token and sends the real one as a bearer token', async () => {
    const { egress, policies } = fakeEgress();
    const { launch } = await withEgress(egress, {
      runtime: 'claude' as const,
      allowHosts: ['api.anthropic.com'],
      command: ['claude'],
      env: [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: 'sk-ant-oat-real' }],
    });
    expect(launch.env?.[0]).toEqual({ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: CLAUDE_OAUTH_PLACEHOLDER });
    expect(policies[0]?.api).toEqual({
      upstream: 'https://api.anthropic.com',
      header: 'authorization',
      value: 'Bearer sk-ant-oat-real',
    });
  });

  it('points Codex with an API key at the proxy through its config flag', async () => {
    const { egress, policies } = fakeEgress();
    const { launch } = await withEgress(egress, {
      runtime: 'codex' as const,
      allowHosts: ['api.openai.com'],
      command: ['codex', 'exec', '--json', 'hi'],
      env: [{ name: 'CODEX_API_KEY', value: 'sk-real' }],
    });
    expect(launch.command).toEqual(['codex', '-c', `openai_base_url="${EGRESS_API}/v1"`, 'exec', '--json', 'hi']);
    expect(launch.env).toEqual([{ name: 'CODEX_API_KEY', value: CODEX_KEY_PLACEHOLDER }]);
    expect(policies[0]?.api?.value).toBe('Bearer sk-real');
  });

  it('keeps a login that cannot be swapped in the container, still behind the proxy', async () => {
    for (const [runtime, name] of [
      ['codex', 'CODEX_AUTH'],
      ['cursor', 'CURSOR_API_KEY'],
    ] as const) {
      const { egress, policies } = fakeEgress();
      const { launch } = await withEgress(egress, {
        runtime,
        allowHosts: ['*.cursor.sh'],
        command: ['agent'],
        env: [{ name, value: 'real' }],
      });
      expect(launch.env).toEqual([{ name, value: 'real' }]);
      expect(launch.egress).toEqual({ ip: '198.18.4.4' });
      expect(policies[0]?.api).toBeUndefined();
    }
  });
});
