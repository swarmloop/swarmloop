import { FetchFailed } from '../../core/swarmloop-error';
import type { CodeHost, MergeMethod } from '../../integrations/code-host/code-host';
import { FakeBacklogHost } from '../../testing/fake-backlog-host';
import { mergeHow } from './merge-method';

function hostAllowing(methods: MergeMethod[]): FakeBacklogHost {
  const fake = new FakeBacklogHost();
  fake.addProject('acme/web', 'main', 'web-head');
  jest.spyOn(fake, 'readMergeMethods').mockResolvedValue({ methods, httpCalls: [] });
  return fake;
}

describe('mergeHow', () => {
  it.each([
    [['merge', 'rebase', 'squash'], 'squash'],
    [['merge', 'rebase'], 'rebase'],
    [['merge'], 'merge'],
  ] as [MergeMethod[], MergeMethod][])(
    'picks the first allowed of squash, rebase, merge from %j',
    async (allowed, method) => {
      await expect(mergeHow(hostAllowing(allowed), 'acme/web', 'Task')).resolves.toEqual({ method, title: 'Task' });
    },
  );

  it('gives no how when no method is allowed, so the host refuses as today', async () => {
    await expect(mergeHow(hostAllowing([]), 'acme/web', 'Task')).resolves.toBeUndefined();
  });

  it('leaves the title out when the repository has no title format', async () => {
    const how = await mergeHow(hostAllowing(['merge']), 'acme/web', null);

    expect(how).toEqual({ method: 'merge' });
    expect(how).not.toHaveProperty('title');
  });

  it('lets a failed read through as the wait it is', async () => {
    const host = {
      readMergeMethods: async () => Promise.reject(new FetchFailed('host timed out')),
    } as unknown as CodeHost;

    await expect(mergeHow(host, 'acme/web', 'Task')).rejects.toBeInstanceOf(FetchFailed);
  });
});
