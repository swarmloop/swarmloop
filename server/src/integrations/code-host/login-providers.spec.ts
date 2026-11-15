import { SystemClock } from '../../core/clock';
import { CodeHostRegistry } from './code-host.registry';
import type { AppCredentials, AppSource } from './login-provider';

const env = {
  GITHUB_BASE_URL: '',
  GITHUB_TOKEN: '',
  GITLAB_BASE_URL: '',
  GITLAB_TOKEN: '',
};

function appsOf(stored: Record<string, AppCredentials>, connecting: string[]): AppSource {
  return { credentials: (host) => stored[host] ?? null, connects: (host) => connecting.includes(host) };
}

describe('login providers of the code hosts', () => {
  it('lists github then gitlab with their labels, prefixes and client env keys', () => {
    const providers = CodeHostRegistry.loginProviders(env, new SystemClock(), appsOf({}, []));
    expect(
      providers.map(({ name, label, appLabel, allowPrefixes, clientEnvKeys }) => ({
        name,
        label,
        appLabel,
        allowPrefixes,
        clientEnvKeys,
      })),
    ).toEqual([
      {
        name: 'github',
        label: 'GitHub',
        appLabel: 'App',
        allowPrefixes: { user: 'github:', group: 'github-org:' },
        clientEnvKeys: { clientId: 'GITHUB_OAUTH_CLIENT_ID', clientSecret: 'GITHUB_OAUTH_CLIENT_SECRET' },
      },
      {
        name: 'gitlab',
        label: 'GitLab',
        appLabel: 'Application',
        allowPrefixes: { user: 'gitlab:', group: 'gitlab-group:' },
        clientEnvKeys: { clientId: 'GITLAB_OAUTH_CLIENT_ID', clientSecret: 'GITLAB_OAUTH_CLIENT_SECRET' },
      },
    ]);
  });

  it('follows the app source for configured and connects', () => {
    const apps = appsOf({ gitlab: { clientId: 'id', clientSecret: 'secret' } }, ['gitlab']);
    const [github, gitlab] = CodeHostRegistry.loginProviders(env, new SystemClock(), apps);
    expect([github?.configured(), github?.connects()]).toEqual([false, false]);
    expect([gitlab?.configured(), gitlab?.connects()]).toEqual([true, true]);
  });
});
