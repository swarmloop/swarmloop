import type { PreparedEnvironment } from '../../environment/environment-types';
import type { ProjectEnvironments } from '../../environment/project-environments';
import type { RunEntity } from '../../history/entities';
import { packageRegistries } from '../../sandbox/sandbox-launch';
import { skillPrompt, LOCAL_RUN_RULE } from './skill-prompt';
import { implementFollowUp, implementImproveFollowUp } from '../implement/implement.prompts';
import { agentWorkplace } from './agent-environment';

const input = { run: {} as RunEntity, key: 'k', step: 'implement', mounts: [], runtime: 'claude' as const };

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

describe('agentWorkplace hosts', () => {
  const withHosts = (network?: 'registries' | 'setup'): PreparedEnvironment => {
    const project = prepared(network);
    project.record.config.hosts = { agent: ['pub.dev'] };
    project.origins = ['git.corp.example'];
    return project;
  };

  it('adds the manifest hosts to the registries and reports them as their own field', async () => {
    const place = await agentWorkplace(environments(withHosts()), input, 'p');
    expect(place.allowHosts).toEqual([...packageRegistries(), 'pub.dev']);
    expect(place.manifestHosts).toEqual({ hosts: ['pub.dev'], origins: ['git.corp.example'] });
  });

  it('gives the agent no host when only the setup reaches the registries', async () => {
    const place = await agentWorkplace(environments(prepared('setup')), input, 'p');
    expect(place.allowHosts).toEqual([]);
    expect(place.manifestHosts).toBeUndefined();
  });

  it('keeps exactly the registries without hosts', async () => {
    const place = await agentWorkplace(environments(prepared()), input, 'p');
    expect(place.allowHosts).toEqual(packageRegistries());
    expect(place).not.toHaveProperty('manifestHosts');
  });
});

describe('agentWorkplace', () => {
  it.each(['implement', 'implement-improve'])(
    'uses current environment permissions for fresh and resumed %s',
    async (step) => {
      const first = skillPrompt(step, '{"prompt":"Update the field"}', ['shop'], [], [], { deferExecutionRules: true });
      const resumed =
        step === 'implement' ? implementFollowUp('- update the field', null) : implementImproveFollowUp(null);
      for (const prompt of [first, resumed]) {
        const project = prepared();
        project.record.config.checks = ['npm test'];
        const place = await agentWorkplace(environments(project), { ...input, step }, prompt);
        expect(place.prompt).not.toContain('Do not run tests');
        expect(place.prompt).not.toContain('Tests run only');
        expect(place.prompt).toContain('You may run any command');
        expect(place.prompt).toContain('- `npm test`');
        const fallback = await agentWorkplace(environments(null), { ...input, step }, prompt);
        expect(fallback.prompt).toContain(LOCAL_RUN_RULE);
        expect(fallback.project).toBeUndefined();
      }
    },
  );

  it('retains an old checklist and scopes inherited planning restrictions on resume', async () => {
    const plan = '- Fix the field.\n- Do not run tests in this sandbox.';
    const place = await agentWorkplace(
      environments(prepared()),
      input,
      implementFollowUp(plan, '## checks\nFAIL npm test'),
    );
    expect(place.prompt).toContain(plan);
    expect(place.prompt).toContain('including resumed sessions');
    expect(place.prompt).toContain(
      'A sandbox test ban copied from those stages into a checklist does not restrict this project environment.',
    );
    expect(place.prompt).toContain('After a pipeline return, run the failing command here first');
  });

  it('lets an agent without a project environment reach the registries', async () => {
    const place = await agentWorkplace(environments(null), input, 'prompt');
    expect(place).toEqual({
      prompt: `prompt\n\n${LOCAL_RUN_RULE}\n`,
      executionRules: LOCAL_RUN_RULE,
      allowHosts: packageRegistries(),
    });
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
