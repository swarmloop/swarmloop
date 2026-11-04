import type { ProjectEnvironments, PreparedEnvironment } from '../../environment/project-environments';
import type { RunEntity } from '../../history/entities';
import { packageRegistries } from '../../sandbox/sandbox-launch';
import { agentWorkplace } from './agent-environment';

const input = { run: {} as RunEntity, key: 'k', step: 'implement', mounts: [] };

function environments(prepared: PreparedEnvironment | null): Pick<ProjectEnvironments, 'prepare'> {
  return { prepare: () => Promise.resolve(prepared) };
}

function prepared(network?: 'registries' | 'setup'): PreparedEnvironment {
  return {
    launch: {
      image: 'img',
      cliVolume: 'swarmloop-cli-codex-0123456789ab',
      path: '/usr/bin',
      certFile: false,
      caches: [],
    },
    record: {
      repo: 'shop',
      config: { source: '.swarmloop.json', cache: [], checks: [], ...(network ? { network } : {}) },
    },
  };
}

describe('agentWorkplace', () => {
  it('lets an agent without a project environment reach the registries', async () => {
    const place = await agentWorkplace(environments(null), input, 'prompt');
    expect(place).toEqual({ prompt: 'prompt', allowHosts: packageRegistries() });
  });

  it('gives the registries to the agent by default', async () => {
    expect((await agentWorkplace(environments(prepared()), input, 'p')).allowHosts).toEqual(packageRegistries());
  });

  it('keeps the agent to the model API when the project keeps the registries to its setup', async () => {
    const place = await agentWorkplace(environments(prepared('setup')), input, 'p');
    expect(place.allowHosts).toEqual([]);
    expect(place.project?.image).toBe('img');
  });
});
