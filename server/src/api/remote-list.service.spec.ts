import { testEnv } from '../config/env.spec-helpers';
import { FakeClock } from '../core/fake-clock.spec-helpers';
import { HostUnavailable } from '../core/swarmloop-error';
import type { CodeHost } from '../integrations/code-host/code-host';
import type { CodeHostRegistry } from '../integrations/code-host/code-host.registry';
import type { CommandService } from '../pipeline/command.service';
import { RemoteRepositories } from '../steps/prepare/remote-repositories.service';
import { RemoteListService } from './remote-list.service';

const repository = { host: 'github', owner: 'acme', name: 'one', visibility: 'private', defaultBranch: 'main' };

/** A command service that stores the commands and lets the spec run their handlers when it chooses. */
function harness(names = ['github']) {
  const clock = new FakeClock();
  const listRepositories = jest.fn(async () => ({ repositories: [repository], more: false, httpCalls: [] }));
  const host = {
    listRepositories,
    listOwners: async () => ({ owners: [], httpCalls: [] }),
  } as unknown as CodeHost;
  const hosts = {
    forRun: () => Promise.resolve(hosts),
    names,
    byName: () => host,
    credentials: () => ({ token: 't', tokenKey: 'GITHUB_TOKEN' }),
  } as unknown as CodeHostRegistry & { forRun(): Promise<CodeHostRegistry> };
  const remote = new RemoteRepositories(
    { env: testEnv({ CHECKOUTS_ROOT: '/nonexistent-checkouts', SWARMLOOP_ROOT: '/nonexistent-root' }) },
    clock,
    hosts,
    {} as never,
  );
  const accepted: { type: string; scope: string; payload: Record<string, unknown>; options: unknown }[] = [];
  const acceptScoped = jest.fn(
    async (type: string, scope: string, payload: Record<string, unknown>, options: unknown) => {
      accepted.push({ type, scope, payload, options });
      return { id: `command-${accepted.length}` };
    },
  );
  const commands = { acceptScoped } as unknown as CommandService;
  return { service: new RemoteListService(remote, commands), remote, accepted, acceptScoped, listRepositories, clock };
}

describe('RemoteListService', () => {
  it('answers loading on the first read and starts one refresh, none on the second', async () => {
    const { service, accepted } = harness();
    const view = await service.view('ann');
    expect(view).toMatchObject({ repositories: [], loading: true, error: null });
    expect(accepted).toEqual([
      expect.objectContaining({ type: 'remote-refresh', scope: 'repositories:ann', payload: { host: 'github' } }),
    ]);
    await service.view('ann');
    expect(accepted).toHaveLength(1);
  });

  it('starts one refresh for two reads at the same time', async () => {
    const { service, accepted } = harness();
    await Promise.all([service.view('ann'), service.view('ann')]);
    expect(accepted).toHaveLength(1);
  });

  it('answers the repositories once the refresh has ended', async () => {
    const { service, remote } = harness();
    await service.view('ann');
    await remote.refresh('ann', 'github');
    expect(await service.view('ann')).toMatchObject({ loading: false, repositories: [{ name: 'one' }] });
  });

  it('starts one refresh for a stale snapshot and answers it at once', async () => {
    const { service, remote, accepted, clock } = harness();
    await remote.refresh('ann', 'github');
    clock.advance(60_000);
    expect(await service.view('ann')).toMatchObject({ loading: false, repositories: [{ name: 'one' }] });
    expect(accepted).toHaveLength(1);
  });

  it('leaves no pending mark when the refresh ends before the view returns', async () => {
    const { service, remote, accepted, acceptScoped } = harness();
    acceptScoped.mockImplementationOnce(async () => {
      await remote.refresh('ann', 'github');
      return { id: 'early' };
    });
    expect(await service.view('ann')).toMatchObject({ loading: false, repositories: [{ name: 'one' }] });
    expect(accepted).toHaveLength(0);
    await service.view('ann');
    expect(accepted).toHaveLength(0);
  });

  it('clears the pending mark when the command cannot be stored', async () => {
    const { service, accepted, acceptScoped } = harness();
    acceptScoped.mockRejectedValueOnce(new Error('disk full'));
    await expect(service.view('ann')).rejects.toThrow('disk full');
    await service.view('ann');
    expect(accepted).toHaveLength(1);
  });

  it('clears the marks of the failed host and of the hosts not sent yet', async () => {
    const { service, accepted, acceptScoped } = harness(['github', 'gitlab']);
    acceptScoped.mockRejectedValueOnce(new Error('disk full'));
    await expect(service.view('ann')).rejects.toThrow('disk full');
    await service.view('ann');
    expect(accepted.map((command) => command.payload.host)).toEqual(['github', 'gitlab']);
  });

  it('answers a failed refresh as an error, does not start it again, and retry starts a new one', async () => {
    const { service, remote, accepted, listRepositories } = harness();
    await service.view('ann');
    listRepositories.mockRejectedValueOnce(new HostUnavailable('GitHub', 'is down', '2026-01-01T00:01:00.000Z'));
    await expect(remote.refresh('ann', 'github')).rejects.toThrow('is down');
    const failed = await service.view('ann');
    expect(failed.error).toContain('is down');
    expect(accepted).toHaveLength(1);
    const retried = await service.retry('ann');
    expect(retried.error).toBeNull();
    expect(accepted).toHaveLength(2);
  });

  it('answers a create with the command id, the body defaults and the idempotency key', async () => {
    const { service, accepted } = harness();
    await expect(service.create({ owner: 'acme', name: 'x' }, ' key-1 ', 'ann')).resolves.toEqual({
      commandId: 'command-1',
    });
    expect(accepted[0]).toMatchObject({
      type: 'create-repository',
      scope: 'repositories:ann',
      payload: { owner: 'acme', name: 'x' },
      options: { idempotencyKey: 'key-1', actor: 'ann' },
    });
  });
});
