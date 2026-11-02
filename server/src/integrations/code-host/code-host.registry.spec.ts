import { ConfigService } from '@nestjs/config';
import { assignCodeHost, CodeHostRegistry } from './code-host.registry';

const env = {
  GITLAB_BASE_URL: 'https://gitlab.example',
  GITLAB_TOKEN: 'gl',
  GITHUB_BASE_URL: 'https://github.com',
  GITHUB_TOKEN: 'gh',
};

function registryFor(values: typeof env): CodeHostRegistry {
  const config = {
    getOrThrow: (key: string) => values[key as keyof typeof env] ?? '',
    get: (key: string) => values[key as keyof typeof env],
  } as ConfigService;
  return CodeHostRegistry.create(config);
}

describe('code host registry', () => {
  it('returns each named host', () => {
    const hosts = registryFor(env);
    expect(hosts.byName('github').name).toBe('github');
    expect(hosts.byName('gitlab').name).toBe('gitlab');
    expect(() => hosts.byName('')).toThrow(/code host is missing/);
  });

  it('matches an https and an ssh origin for each vendor', () => {
    const hosts = registryFor(env);
    expect(hosts.forOrigin('https://github.com/acme/demo.git')).toBe('github');
    expect(hosts.forOrigin('git@github.com:acme/demo.git')).toBe('github');
    expect(hosts.forOrigin('https://gitlab.example/group/demo.git')).toBe('gitlab');
    expect(hosts.forOrigin('ssh://git@gitlab.example/group/demo.git')).toBe('gitlab');
  });

  it('returns nothing when no vendor matches', () => {
    expect(registryFor(env).forOrigin('git@other.example:group/demo.git')).toBeNull();
    expect(registryFor(env).forOrigin('/tmp/demo.git')).toBeNull();
  });
});

describe('code host credentials', () => {
  it('matches an origin to the configured base hostname', () => {
    expect(registryFor(env).forOrigin('git@github.com:acme/demo.git')).toBe('github');
    expect(registryFor({ ...env, GITLAB_BASE_URL: '' }).forOrigin('https://github.com/acme/demo.git')).toBe('github');
    expect(registryFor(env).forOrigin('git@gitlab.example:group/demo.git')).toBe('gitlab');
    expect(registryFor({ ...env, GITHUB_BASE_URL: '' }).forOrigin('ssh://git@gitlab.example/group/demo.git')).toBe('gitlab');
  });

  it('returns nothing for a path, a blank base, or an unknown host', () => {
    expect(registryFor(env).forOrigin('/tmp/demo.git')).toBeNull();
    expect(registryFor({ ...env, GITLAB_BASE_URL: '', GITHUB_BASE_URL: '' }).forOrigin('git@gitlab.example:group/demo.git')).toBeNull();
    expect(registryFor({ ...env, GITLAB_BASE_URL: 'not a url' }).forOrigin('git@gitlab.example:group/demo.git')).toBeNull();
    expect(registryFor(env).forOrigin('git@other.example:group/demo.git')).toBeNull();
    expect(registryFor({ ...env, GITLAB_BASE_URL: '', GITHUB_BASE_URL: '' }).forOrigin('')).toBeNull();
  });

  it('refuses a hostname configured for both hosts', () => {
    expect(() =>
      registryFor({ ...env, GITLAB_BASE_URL: 'https://gitlab.example', GITHUB_BASE_URL: 'https://gitlab.example' }).forOrigin(
        'git@gitlab.example:group/demo.git',
      ),
    ).toThrow(/gitlab\.example matches both code hosts/);
  });

  it('selects the named credential pair and rejects an empty name', () => {
    expect(registryFor(env).credentials('github').tokenKey).toBe('GITHUB_TOKEN');
    expect(registryFor(env).credentials('gitlab').baseKey).toBe('GITLAB_BASE_URL');
    expect(() => registryFor(env).credentials('')).toThrow(/code host is missing/);
    expect(() => registryFor({ ...env, GITHUB_TOKEN: '' }).requiredCredentials('github')).toThrow(/GITHUB_TOKEN is missing/);
  });

  it('keeps one host for the run', () => {
    const run = { codeHost: 'gitlab' };
    assignCodeHost(run, ['github'], true);
    expect(run.codeHost).toBe('github');
    assignCodeHost(run, [null], true);
    expect(run.codeHost).toBe('github');
    expect(() => assignCodeHost(run, ['gitlab'], false)).toThrow(/origin is not github/);
    expect(run.codeHost).toBe('github');
    const mixed = { codeHost: 'gitlab' };
    expect(() => assignCodeHost(mixed, ['github', 'gitlab'], true)).toThrow(/origins use github and gitlab/);
    expect(mixed.codeHost).toBe('gitlab');
  });
});
