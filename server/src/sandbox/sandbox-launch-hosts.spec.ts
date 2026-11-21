import { hostRefusal, packageRegistries, setupHosts } from './sandbox-hosts';
import { sandboxArgs } from './sandbox-launch';
import { home, launch } from './sandbox-launch.spec-helpers';

describe('sandbox launch', () => {
  describe('manifest hosts', () => {
    const saved = { ...process.env };
    afterEach(() => {
      for (const name of ['GITLAB_BASE_URL', 'GITHUB_BASE_URL', 'JIRA_BASE_URL', 'PROJECT_HOSTS_ALLOW']) {
        if (saved[name] === undefined) {
          delete process.env[name];
        } else {
          process.env[name] = saved[name];
        }
      }
    });

    it('keeps the built-in lists and adds the extra hosts once', () => {
      expect(setupHosts(['pub.dev', 'pypi.org'])).toEqual([...setupHosts(), 'pub.dev']);
      expect(packageRegistries(['pub.dev'])).toEqual([...packageRegistries(), 'pub.dev']);
      expect(packageRegistries()).not.toContain('pub.dev');
    });

    it.each([
      ['github.com', 'is a code host'],
      ['gitlab.com', 'is a code host'],
      ['api.anthropic.com', 'is a model API host'],
      ['localhost', 'is a local address'],
      ['10.0.0.1', 'is a local address'],
      ['::1', 'is a local address'],
      ['https://pub.dev', 'is not a host name'],
      ['pub.dev', null],
      ['registry.npmjs.org', null],
    ])('the ceiling answers %p: %p', (host, reason) => {
      expect(hostRefusal(host, 'agent', [])).toBe(reason);
    });

    it('refuses the hosts of the code hosts, Jira and the checkout origin', () => {
      process.env.GITLAB_BASE_URL = 'https://git.corp.example/api/v4';
      process.env.GITHUB_BASE_URL = 'https://ghe.corp.example';
      process.env.JIRA_BASE_URL = 'https://corp.atlassian.net';
      for (const host of ['git.corp.example', 'ghe.corp.example', 'corp.atlassian.net', 'origin.example']) {
        expect(hostRefusal(host, 'setup', ['origin.example'])).toBe('is a code host');
      }
    });

    it('keeps the setup downloads away from the agent but not from the setup', () => {
      expect(hostRefusal('nodejs.org', 'agent', [])).toBe('is setup-only');
      expect(hostRefusal('nodejs.org', 'setup', [])).toBeNull();
      expect(hostRefusal('github.com', 'agent', [])).toBe('is a code host');
    });

    it('limits the manifest to PROJECT_HOSTS_ALLOW when it is set', () => {
      expect(hostRefusal('pub.dev', 'agent', [])).toBeNull();
      process.env.PROJECT_HOSTS_ALLOW = 'pub.dev, Storage.googleapis.com';
      expect(hostRefusal('pub.dev', 'agent', [])).toBeNull();
      expect(hostRefusal('storage.googleapis.com', 'setup', [])).toBeNull();
      expect(hostRefusal('example.org', 'agent', [])).toBe('is not in PROJECT_HOSTS_ALLOW');
      process.env.PROJECT_HOSTS_ALLOW = 'github.com';
      expect(hostRefusal('github.com', 'agent', [])).toBe('is a code host');
    });

    it('lets sandboxArgs launch a manifest host and refuses one that breaks the ceiling again', () => {
      const manifestHosts = { hosts: ['pub.dev'], origins: [] };
      const args = sandboxArgs(launch({ allowHosts: ['pub.dev'], manifestHosts }), home);
      expect(args).toEqual(sandboxArgs(launch({ allowHosts: ['pub.dev'], manifestHosts }), home));
      expect(() =>
        sandboxArgs(
          launch({ allowHosts: ['gitlab.com'], manifestHosts: { hosts: ['gitlab.com'], origins: [] } }),
          home,
        ),
      ).toThrow('gitlab.com is a code host');
      expect(() =>
        sandboxArgs(
          launch({
            allowHosts: ['git.corp.example'],
            manifestHosts: { hosts: ['git.corp.example'], origins: ['git.corp.example'] },
          }),
          home,
        ),
      ).toThrow('git.corp.example is a code host');
    });

    it('still refuses an allowed host that the manifest did not name', () => {
      expect(() =>
        sandboxArgs(
          launch({ allowHosts: ['pub.dev', 'api.example.com'], manifestHosts: { hosts: ['pub.dev'], origins: [] } }),
          home,
        ),
      ).toThrow('api.example.com is a production host');
      expect(() => sandboxArgs(launch({ allowHosts: ['pub.dev'] }), home)).toThrow('pub.dev is a production host');
    });
  });
});
