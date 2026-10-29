import { assignCodeHost, codeHostFromOrigin, requireHostCredentials, selectedHost } from './host-credentials';

const env = {
  GITLAB_BASE_URL: 'https://gitlab.example',
  GITLAB_TOKEN: 'gl',
  GITHUB_BASE_URL: 'https://github.com',
  GITHUB_TOKEN: 'gh',
};

describe('code host credentials', () => {
  it('matches an origin to the configured base hostname', () => {
    expect(codeHostFromOrigin('git@github.com:acme/demo.git', env.GITLAB_BASE_URL, env.GITHUB_BASE_URL)).toBe('github');
    expect(codeHostFromOrigin('https://github.com/acme/demo.git', '', env.GITHUB_BASE_URL)).toBe('github');
    expect(codeHostFromOrigin('git@gitlab.example:group/demo.git', env.GITLAB_BASE_URL, env.GITHUB_BASE_URL)).toBe('gitlab');
    expect(codeHostFromOrigin('ssh://git@gitlab.example/group/demo.git', env.GITLAB_BASE_URL, '')).toBe('gitlab');
  });

  it('returns nothing for a path, a blank base, or an unknown host', () => {
    expect(codeHostFromOrigin('/tmp/demo.git', env.GITLAB_BASE_URL, env.GITHUB_BASE_URL)).toBeNull();
    expect(codeHostFromOrigin('git@gitlab.example:group/demo.git', '', '')).toBeNull();
    expect(codeHostFromOrigin('git@gitlab.example:group/demo.git', 'not a url', env.GITHUB_BASE_URL)).toBeNull();
    expect(codeHostFromOrigin('git@other.example:group/demo.git', env.GITLAB_BASE_URL, env.GITHUB_BASE_URL)).toBeNull();
    expect(codeHostFromOrigin('', '', '')).toBeNull();
  });

  it('refuses a hostname configured for both hosts', () => {
    expect(() => codeHostFromOrigin('git@gitlab.example:group/demo.git', 'https://gitlab.example', 'https://gitlab.example')).toThrow(
      /gitlab\.example matches both code hosts/,
    );
  });

  it('selects the named credential pair and rejects an empty name', () => {
    expect(selectedHost(env, 'github').tokenKey).toBe('GITHUB_TOKEN');
    expect(selectedHost(env, 'gitlab').baseKey).toBe('GITLAB_BASE_URL');
    expect(() => selectedHost(env, '')).toThrow(/code host is missing/);
    expect(() => requireHostCredentials({ ...env, GITHUB_TOKEN: '' }, 'github')).toThrow(/GITHUB_TOKEN is missing/);
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
