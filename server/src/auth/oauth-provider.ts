import { createHash } from 'crypto';
import type { Clock } from '../core/clock';
import { SwarmloopError } from '../core/swarmloop-error';
import { request } from '../integrations/http';
import type { SwarmloopEnv } from '../config/env';

export type ProviderName = 'github' | 'gitlab';

/** The tokens a login granted, for a provider that keeps them. */
export interface Grant {
  accessToken: string;
  refreshToken: string;
  /** Seconds the access token lives, or undefined when it does not expire. */
  expiresIn?: number;
}

interface Identity {
  user: string;
  /** The orgs (GitHub) or groups (GitLab) the person belongs to. */
  groups: string[];
  /** Set when the provider connects the person: one authorization signs in and connects. */
  grant?: Grant;
}

/** The client id and secret of the app a login goes through. */
export interface AppCredentials {
  clientId: string;
  clientSecret: string;
}

export interface OAuthProvider {
  readonly name: ProviderName;
  /** Both the client id and the secret are set. */
  configured(): boolean;
  /** True when the login also keeps the person's tokens: a GitHub App, or GitLab. */
  connects(): boolean;
  authorizeUrl(redirectUri: string, state: string, verifier: string): string;
  /** Trades the code for a token, reads the login and memberships, and drops the token unless the provider connects. An empty verifier means the code was not asked for with PKCE. */
  identify(code: string, redirectUri: string, verifier: string): Promise<Identity>;
  /** The owner of the configured `GITHUB_TOKEN` / `GITLAB_TOKEN`, or null when none is set. */
  tokenOwner(): Promise<string | null>;
}

type OAuthEnv = Pick<
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

export interface Endpoints {
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
    private readonly app: () => AppCredentials | null,
    private readonly serverToken: string,
    private readonly endpoints: Endpoints,
    private readonly keepsTokens: () => boolean,
  ) {}

  configured(): boolean {
    return this.app() !== null;
  }

  connects(): boolean {
    return this.keepsTokens();
  }

  authorizeUrl(redirectUri: string, state: string, verifier: string): string {
    const url = new URL(this.endpoints.authorize);
    url.search = new URLSearchParams({
      client_id: this.credentials().clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: this.endpoints.scope,
      state,
      ...(verifier ? { code_challenge: challengeOf(verifier), code_challenge_method: 'S256' } : {}),
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
          client_id: this.credentials().clientId,
          client_secret: this.credentials().clientSecret,
          code,
          redirect_uri: redirectUri,
          ...(verifier ? { code_verifier: verifier } : {}),
          grant_type: 'authorization_code',
        }),
      },
    )) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!granted.access_token) {
      throw new SwarmloopError(`${this.name} did not accept the login code`);
    }
    const headers = this.endpoints.userHeaders(granted.access_token);
    const { groups } = this.endpoints;
    return {
      user: await this.userOf(headers),
      groups: names(await this.send(`${this.endpoints.api}${groups.path}`, headers), groups.field),
      ...(this.keepsTokens()
        ? {
            grant: {
              accessToken: granted.access_token,
              refreshToken: granted.refresh_token ?? '',
              expiresIn: granted.expires_in,
            },
          }
        : {}),
    };
  }

  async tokenOwner(): Promise<string | null> {
    if (this.serverToken === '') {
      return null;
    }
    return this.userOf(this.endpoints.userHeaders(this.serverToken));
  }

  private credentials(): AppCredentials {
    const app = this.app();
    if (!app) {
      throw new SwarmloopError(`${this.name} login is not configured`);
    }
    return app;
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

export function githubEndpoints(env: Pick<OAuthEnv, 'GITHUB_BASE_URL'>): Endpoints {
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

export function gitlabEndpoints(env: Pick<OAuthEnv, 'GITLAB_BASE_URL'>): Endpoints {
  const base = new URL(env.GITLAB_BASE_URL || 'https://gitlab.com');
  const root = base.toString().replace(/\/$/, '');
  return {
    authorize: `${root}/oauth/authorize`,
    token: `${root}/oauth/token`,
    api: `${root}/api/v4`,
    scope: 'read_user api write_repository',
    userHeaders: (token) => ({ Authorization: `Bearer ${token}` }),
    user: { path: '/user', field: 'username' },
    groups: { path: '/groups?min_access_level=10&per_page=100', field: 'full_path' },
  };
}

/** Where a provider finds its app: the one Connect stored, else the OAuth app of the environment. */
export interface AppSource {
  credentials(host: ProviderName): AppCredentials | null;
  connects(host: ProviderName): boolean;
}

export function oauthProviders(env: OAuthEnv, clock: Clock, apps: AppSource): OAuthProvider[] {
  return [
    new HttpOAuthProvider(
      'github',
      clock,
      () => apps.credentials('github'),
      env.GITHUB_TOKEN,
      githubEndpoints(env),
      () => apps.connects('github'),
    ),
    new HttpOAuthProvider(
      'gitlab',
      clock,
      () => apps.credentials('gitlab'),
      env.GITLAB_TOKEN,
      gitlabEndpoints(env),
      () => apps.connects('gitlab'),
    ),
  ];
}
