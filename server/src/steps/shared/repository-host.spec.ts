import { Logger } from '@nestjs/common';
import { HostUnavailable } from '../../core/swarmloop-error';
import type { PipelineCheck } from '../../integrations/code-host/code-host';
import type { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { FakeBacklogHost, pipelineOf } from '../../testing/fake-backlog-host';
import { RepositoryHost } from './repository-host';
import type { RepositoryOrigins } from './repository-origins';
import type { RunNames } from './run-names';

function check(name: string, status: PipelineCheck['status'], durationMs = 1000): PipelineCheck {
  return { id: 1, name, app: '', status, durationMs, url: '', summary: '', annotations: [], workflow: true };
}

const run = { codeHost: 'backlog-fake', startedBy: 'ada', key: 'PROJ-1', parentRunId: null, taskId: null };
const request = { project: 'acme/web', iid: 7 };

function setup(title: string | null = null) {
  const fake = new FakeBacklogHost();
  fake.addProject('acme/web', 'main', 'web-head');
  const origins = new Map([['web', { origin: FakeBacklogHost.originOf('acme/web'), project: 'acme/web' }]]);
  const registry = {
    forRun: async () => registry,
    forOrigin: (origin: string) => (fake.matchesOrigin(origin) ? fake.name : null),
    byName: () => fake,
    hostFor: async () => fake,
  } as unknown as CodeHostRegistry;
  const names = { taskTitle: async () => title } as unknown as RunNames;
  const originsOf = { of: async (repo: string) => origins.get(repo) } as unknown as RepositoryOrigins;
  return { fake, host: new RepositoryHost(originsOf, registry, names) };
}

describe('RepositoryHost', () => {
  afterEach(() => jest.restoreAllMocks());

  it('reads a green main', async () => {
    const { fake, host } = setup();
    fake.setPipeline('acme/web', pipelineOf('success', [check('test', 'success', 4000)], 'https://ci/1'));

    await expect(host.main('web', 'ada')).resolves.toEqual({
      repository: 'web',
      branch: 'main',
      state: 'green',
      head: 'web-head',
      failingJobs: [],
      durationMs: 4000,
      url: 'https://ci/1',
    });
  });

  it('reads a main with a running pipeline as pending', async () => {
    const { fake, host } = setup();
    fake.setPipeline('acme/web', pipelineOf('running', [check('test', 'running')]));

    expect((await host.main('web', 'ada')).state).toBe('pending');
  });

  it('reads a main whose branch has no pipeline at all as none', async () => {
    const { host } = setup();

    await expect(host.main('web', 'ada')).resolves.toMatchObject({ state: 'none', durationMs: null, url: null });
  });

  it('reads a snapshot with no runs and no checks as none', async () => {
    const { fake, host } = setup();
    fake.setPipeline('acme/web', pipelineOf('success'));

    expect((await host.main('web', 'ada')).state).toBe('none');
  });

  it('reads a head with no pipeline on a branch that has an earlier pipeline as pending', async () => {
    const { fake, host } = setup();
    fake.setPipeline('acme/web', pipelineOf('success', [check('test', 'success')]));
    fake.setHead('acme/web', 'web-head-2');

    expect((await host.main('web', 'ada')).state).toBe('pending');
  });

  it('reads a main whose host refuses the pipelines as none, without throwing', async () => {
    const { fake, host } = setup();
    fake.refusePipelines('acme/web');

    await expect(host.main('web', 'ada')).resolves.toMatchObject({ state: 'none', head: 'web-head' });
  });

  it('gives a gate no failing and no pending checks when the host refuses the pipelines', async () => {
    const { fake, host } = setup();
    fake.setGate('acme/web', 7, { mergeability: 'clean' });
    fake.refusePipelines('acme/web');

    await expect(host.gate(run, request, 'feature')).resolves.toMatchObject({ failing: [], pending: [] });
  });

  it('logs the reading of a main once, until its state changes', async () => {
    const { fake, host } = setup();
    const lines: string[] = [];
    jest.spyOn(Logger.prototype, 'log').mockImplementation((message: unknown) => void lines.push(String(message)));
    fake.refusePipelines('acme/web');

    await host.main('web', 'ada');
    await host.main('web', 'ada');
    expect(lines).toEqual(['main of web reads none: the code host refuses to read pipelines (HTTP 403)']);

    fake.refusePipelines('acme/web', false);
    fake.setPipeline('acme/web', pipelineOf('success', [check('test', 'success')]));
    await host.main('web', 'ada');
    expect(lines).toHaveLength(2);
    expect(lines[1]).toBe('main of web reads green');
  });

  it('reads a red main with its failing jobs and the duration', async () => {
    const { fake, host } = setup();
    fake.setPipeline(
      'acme/web',
      pipelineOf('failed', [check('lint', 'failed', 2000), check('test', 'canceled', 9000), check('build', 'success')]),
    );

    await expect(host.main('web', 'ada')).resolves.toMatchObject({
      state: 'red',
      failingJobs: ['lint', 'test'],
      durationMs: 9000,
    });
  });

  it('names the failing and pending checks of a gate', async () => {
    const { fake, host } = setup();
    fake.setGate('acme/web', 7, { mergeability: 'blocked', blockedBy: 'checks' });
    fake.setChecks('acme/web', 7, [
      check('lint', 'failed'),
      check('test', 'running'),
      check('deploy', 'manual'),
      check('build', 'success'),
    ]);

    await expect(host.gate(run, request, 'feature')).resolves.toMatchObject({
      mergeability: 'blocked',
      head: 'acme/web-pr-7',
      failing: ['lint'],
      pending: ['test', 'deploy'],
    });
  });

  it('merges with the head as a guard and moves main to a commit with no pipeline', async () => {
    const { fake, host } = setup();
    fake.setPipeline('acme/web', pipelineOf('success', [check('test', 'success')]));

    const sha = await host.merge(run, 'web', 'Add it', request, 'acme/web-pr-7');

    expect(sha).toBe('acme/web-merge-1');
    expect(fake.calls.find((call) => call.name === 'mergeMergeRequest')?.args).toEqual([
      'acme/web',
      7,
      'acme/web-pr-7',
      { method: 'squash' },
    ]);
    expect((await host.main('web', 'ada')).state).toBe('pending');
  });

  it('merges with the title of the format when the repository has one', async () => {
    const { fake, host } = setup('Ship: Add it');

    await host.merge(run, 'web', 'Add it', request, 'acme/web-pr-7');

    expect(fake.calls.find((call) => call.name === 'mergeMergeRequest')?.args[3]).toEqual({
      method: 'squash',
      title: 'Ship: Add it',
    });
  });

  it('passes an outage through', async () => {
    const { fake, host } = setup();
    fake.hostDown('2026-11-16T10:00:00.000Z');

    await expect(host.main('web', 'ada')).rejects.toBeInstanceOf(HostUnavailable);
    await expect(host.merge(run, 'web', 'Add it', request, 'x')).rejects.toBeInstanceOf(HostUnavailable);
  });
});
