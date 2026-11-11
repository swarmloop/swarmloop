import { bindRefusal } from './bind-check';

const none = {
  GITHUB_OAUTH_CLIENT_ID: '',
  GITHUB_OAUTH_CLIENT_SECRET: '',
  GITLAB_OAUTH_CLIENT_ID: '',
  GITLAB_OAUTH_CLIENT_SECRET: '',
};

describe('bindRefusal', () => {
  const env = (host: string, publicUrl: string, extra = {}) => ({
    ...none,
    SWARMLOOP_API_HOST: host,
    SWARMLOOP_PUBLIC_URL: publicUrl,
    ...extra,
  });

  it('lets a loopback host start without a provider', () => {
    expect(bindRefusal(env('127.0.0.1', 'http://127.0.0.1:3921'))).toBeNull();
  });

  it('lets 0.0.0.0 start while the public URL is on loopback (compose publishes on 127.0.0.1)', () => {
    expect(bindRefusal(env('0.0.0.0', 'http://127.0.0.1:3921'))).toBeNull();
  });

  it('refuses 0.0.0.0 with a public URL and names the missing variables', () => {
    expect(bindRefusal(env('0.0.0.0', 'https://panel.example'))).toContain('GITHUB_OAUTH_CLIENT_ID');
    expect(bindRefusal(env('10.0.0.5', 'http://127.0.0.1:3921'))).not.toBeNull();
  });

  it('lets any host start when a provider is configured', () => {
    const github = { GITHUB_OAUTH_CLIENT_ID: 'id', GITHUB_OAUTH_CLIENT_SECRET: 'secret' };
    expect(bindRefusal(env('0.0.0.0', 'https://panel.example', github))).toBeNull();
    expect(bindRefusal(env('0.0.0.0', 'https://panel.example', { GITHUB_OAUTH_CLIENT_ID: 'id' }))).not.toBeNull();
  });
});
