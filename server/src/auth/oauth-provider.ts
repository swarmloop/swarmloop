import { createHash } from 'crypto';
import type { Clock } from '../core/clock';
import { SwarmloopError } from '../core/swarmloop-error';
import { request } from '../integrations/http';
import type { SwarmloopEnv } from '../config/env';

export type ProviderName = 'github' | 'gitlab';

interface Identity {
  user: string;
  /** The orgs (GitHub) or groups (GitLab) the person belongs to. */
  groups: string[];
}

export interface OAuthProvider {
  readonly name: ProviderName;
  /** Both the client id and the secret are set. */
  configured(): boolean;
  authorizeUrl(redirectUri: string, state: string, verifier: string): string;
  /** Trades the code for a token, reads the login and memberships, and drops the token. */
  identify(code: string, redirectUri: string, verifier: string): Promise<Identity>;
  /** The owner of the configured `GITHUB_TOKEN` / `GITLAB_TOKEN`, or null when none is set. */
  tokenOwner(): Promise<string | null>;
}

type Env = Pick<
  SwarmloopEnv,
  | 'GITHUB_BASE_URL'
  | 'GITHUB_TOKEN'
  | 'GITHUB_OAUTH_CLIENT_ID'
  | 'GITHUB_OAUTH_CLIENT_SECRET'
  | 'GITLAB_BASE_URL'
  | 'GITLAB_TOKEN'
  | 'GITLAB_OAUTH_CLIENT_ID'
  | 'GITLAB_OAUTH_CLIENT_SECRET'
>;

interface Endpoints {
  authorize: string;
  token: string;
  api: string;
  scope: string;
  /** The call that names the person, and the field that holds the login. */
  user: { path: string; field: string };
  /** The call that lists orgs or groups, and the field that holds each name. */
  groups: { path: string; field: string };
  userHeaders(token: string): Record<string, string>;
}

function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

class HttpOAuthProvider implements OAuthProvider {
  constructor(
    readonly name: ProviderName,
    private readonly clock: Clock,
    private readonly clientId: string,
    private readonly secret: string,
    private readonly serverToken: string,
    private readonly endpoints: Endpoints,
  ) {}

  configured(): boolean {
    return this.clientId !== '' && this.secret !== '';
  }

  authorizeUrl(redirectUri: string, state: string, verifier: string): string {
    const url = new URL(this.endpoints.authorize);
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: this.endpoints.scope,
      state,
      code_challenge: challengeOf(verifier),
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  async identify(code: string, redirectUri: string, verifier: string): Promise<Identity> {
    const granted = (await this.send(
      this.endpoints.token,
      { Accept: 'application/json', 'Content-Type': 'application/json' },
      {
        method: 'POST',
        body: JSON.stringify({
          client_id: this.clientId,
          client_secret: this.secret,
          code,
          redirect_uri: redirectUri,
          code_verifier: verifier,
          grant_type: 'authorization_code',
        }),
      },
    )) as { access_token?: string };
    if (!granted.access_token) {
      throw new SwarmloopError(`${this.name} did not accept the login code`);
    }
    const headers = this.endpoints.userHeaders(granted.access_token);
    const { groups } = this.endpoints;
    return {
      user: await this.userOf(headers),
      groups: names(await this.send(`${this.endpoints.api}${groups.path}`, headers), groups.field),
    };
  }

  async tokenOwner(): Promise<string | null> {
    if (this.serverToken === '') {
      return null;
    }
    return this.userOf(this.endpoints.userHeaders(this.serverToken));
  }

  private async userOf(headers: Record<string, string>): Promise<string> {
    const { user } = this.endpoints;
    const row = (await this.send(`${this.endpoints.api}${user.path}`, headers)) as Record<string, unknown>;
    return text(row[user.field]);
  }

  private async send(url: string, headers: Record<string, string>, init?: { method: string; body: string }) {
    const response = await request(this.clock, url, headers, [], init);
    if (response.status >= 400) {
      throw new SwarmloopError(`${this.name} answered ${response.status}`);
    }
    return JSON.parse(response.body.toString('utf8')) as unknown;
  }
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const names = (rows: unknown, field: string): string[] =>
  (Array.isArray(rows) ? rows : []).map((row) => text((row as Record<string, unknown>)[field]));

function github(env: Env): Endpoints {
  const base = new URL(env.GITHUB_BASE_URL || 'https://github.com');
  const hosted = base.hostname === 'github.com' || base.hostname === 'www.github.com';
  return {
    authorize: `${base.origin}/login/oauth/authorize`,
    token: `${base.origin}/login/oauth/access_token`,
    api: hosted ? 'https://api.github.com' : `${base.origin}/api/v3`,
    scope: 'read:user read:org',
    userHeaders: (token) => ({
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'swarmloop',
    }),
    user: { path: '/user', field: 'login' },
    groups: { path: '/user/orgs?per_page=100', field: 'login' },
  };
}

function gitlab(env: Env): Endpoints {
  const base = new URL(env.GITLAB_BASE_URL || 'https://gitlab.com');
  const root = base.toString().replace(/\/$/, '');
  return {
    authorize: `${root}/oauth/authorize`,
    token: `${root}/oauth/token`,
    api: `${root}/api/v4`,
    scope: 'read_user read_api',
    userHeaders: (token) => ({ Authorization: `Bearer ${token}` }),
    user: { path: '/user', field: 'username' },
    groups: { path: '/groups?min_access_level=10&per_page=100', field: 'full_path' },
  };
}

export function oauthProviders(env: Env, clock: Clock): OAuthProvider[] {
  return [
    new HttpOAuthProvider(
      'github',
      clock,
      env.GITHUB_OAUTH_CLIENT_ID,
      env.GITHUB_OAUTH_CLIENT_SECRET,
      env.GITHUB_TOKEN,
      github(env),
    ),
    new HttpOAuthProvider(
      'gitlab',
      clock,
      env.GITLAB_OAUTH_CLIENT_ID,
      env.GITLAB_OAUTH_CLIENT_SECRET,
      env.GITLAB_TOKEN,
      gitlab(env),
    ),
  ];
}
