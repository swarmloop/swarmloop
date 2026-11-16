import 'reflect-metadata';
import { NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import type { AppConfig } from '../config/env';
import type { PipelineCheck } from '../integrations/code-host/code-host';
import type { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import { SwarmloopError } from '../core/swarmloop-error';
import { RepositoryHost } from '../steps/shared/repository-host';
import type { RepositoryOrigins } from '../steps/shared/repository-origins';
import { FakeBacklogHost, pipelineOf } from '../testing/fake-backlog-host';
import { RepositoriesController } from './repositories.controller';

function check(name: string, status: PipelineCheck['status'], durationMs: number): PipelineCheck {
  return { id: 1, name, app: '', status, durationMs, url: '', summary: '', annotations: [], workflow: true };
}

function setup(allowed: string[] = []) {
  const fake = new FakeBacklogHost();
  fake.addProject('acme/web', 'main', 'web-head');
  const known = new Map([['web', { origin: FakeBacklogHost.originOf('acme/web'), project: 'acme/web' }]]);
  const registry = {
    forRun: async () => registry,
    forOrigin: (origin: string) => (fake.matchesOrigin(origin) ? fake.name : null),
    byName: () => fake,
  } as unknown as CodeHostRegistry;
  const origins = {
    of: async (repo: string) => {
      const found = known.get(repo);
      if (!found) throw new SwarmloopError(`${repo} is not a checkout`);
      return found;
    },
  } as unknown as RepositoryOrigins;
  const config = { env: { SWARMLOOP_REPOS: allowed } } as unknown as AppConfig;
  return { fake, controller: new RepositoriesController(new RepositoryHost(origins, registry), config) };
}

describe('RepositoriesController', () => {
  it('reads a green main', async () => {
    const { fake, controller } = setup();
    fake.setPipeline('acme/web', pipelineOf('success', [check('test', 'success', 4000)], 'https://ci/1'));

    await expect(controller.main('ada', 'web')).resolves.toEqual({
      repository: 'web',
      branch: 'main',
      state: 'green',
      head: 'web-head',
      failingJobs: [],
      durationMs: 4000,
      url: 'https://ci/1',
    });
  });

  it('reads a running pipeline and a head with no pipeline as pending', async () => {
    const { fake, controller } = setup();
    await expect(controller.main('ada', 'web')).resolves.toMatchObject({ state: 'pending', head: 'web-head' });

    fake.setPipeline('acme/web', pipelineOf('running', [check('test', 'running', 100)]));
    await expect(controller.main('ada', 'web')).resolves.toMatchObject({ state: 'pending' });
  });

  it('reads a red main with its failing jobs and duration', async () => {
    const { fake, controller } = setup();
    fake.setPipeline('acme/web', pipelineOf('failed', [check('lint', 'success', 1000), check('test', 'failed', 7000)]));

    await expect(controller.main('ada', 'web')).resolves.toMatchObject({
      state: 'red',
      head: 'web-head',
      failingJobs: ['test'],
      durationMs: 7000,
    });
  });

  it('answers 404 naming an unknown repository', async () => {
    const { controller } = setup();

    const error = await controller.main('ada', 'nope').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(NotFoundException);
    expect((error as Error).message).toContain('nope');
  });

  it('answers 404 for a name that is not allowed or not a plain name', async () => {
    const { controller } = setup(['server']);

    await expect(controller.main('ada', 'web')).rejects.toThrow(NotFoundException);
    await expect(setup().controller.main('ada', '..')).rejects.toThrow(NotFoundException);
  });

  it('answers 503 with the next try when the host is down', async () => {
    const { fake, controller } = setup();
    fake.hostDown('2026-11-12T10:05:00Z');

    const error = await controller.main('ada', 'web').catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect((error as Error).message).toContain('2026-11-12T10:05:00Z');
  });
});
