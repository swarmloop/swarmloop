import type { CodeHostRegistry } from '../../integrations/code-host/code-host.registry';
import { RepositoryHost } from '../../steps/shared/repository-host';
import type { RepositoryOrigins } from '../../steps/shared/repository-origins';
import type { RunNames } from '../../steps/shared/run-names';
import { FakeBacklogHost } from '../../testing/fake-backlog-host';
import { mainWaitFor, readMains } from './main-readings';
import type { MainReading } from './task-readiness';

describe('mainWaitFor', () => {
  it('gives no wait for a main that passes', () => {
    expect(mainWaitFor('web', { state: 'green' }, false)).toBeNull();
    expect(mainWaitFor('web', { state: 'none' }, false)).toBeNull();
  });

  it('waits for a red, pending or unread main', () => {
    expect(mainWaitFor('web', { state: 'red' }, false)).toBe('waits for a green main of web');
    expect(mainWaitFor('web', { state: 'pending' }, false)).toBe('waits for a green main of web');
    expect(mainWaitFor('web', undefined, false)).toBe('waits for a green main of web');
  });

  it('says why a main cannot be read', () => {
    expect(mainWaitFor('web', { state: 'unreadable', note: 'host down' }, false)).toBe(
      'waits for a green main of web: host down',
    );
  });

  it('gives no wait to the task that fixes this main', () => {
    expect(mainWaitFor('web', { state: 'red' }, true)).toBeNull();
  });
});

describe('readMains', () => {
  it('makes a main whose CI the host does not show a wait that names the repository, the access and the next try', async () => {
    const fake = new FakeBacklogHost();
    fake.addProject('acme/web', 'main', 'web-head');
    fake.refuseCi('acme/web', '2030-01-01T00:00:00.000Z');
    const registry = {
      forRun: async () => registry,
      forOrigin: () => fake.name,
      byName: () => fake,
    } as unknown as CodeHostRegistry;
    const origins = {
      of: async () => ({ origin: FakeBacklogHost.originOf('acme/web'), project: 'acme/web' }),
    } as unknown as RepositoryOrigins;
    const host = new RepositoryHost(origins, registry, {} as RunNames);
    const cache = new Map<string, MainReading>();

    await readMains(host, ['web'], 'ada', cache);

    const wait = mainWaitFor('web', cache.get('web'), false);
    expect(wait).toContain('waits for a green main of web: ');
    expect(wait).toContain('acme/web');
    expect(wait).toContain('CI read access');
    expect(wait).toContain('next try at 2030-01-01T00:00:00.000Z');
  });
});
