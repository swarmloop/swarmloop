import { createHash } from 'crypto';
import type { Clock } from '../../core/clock';
import { SwarmloopError } from '../../core/swarmloop-error';
import { request } from '../http';
import type {
  AppCredentials,
  AppFlow,
  AppSource,
  Endpoints,
  Grant,
  Identity,
  LoginFacts,
  LoginProvider,
  ProviderName,
  RepoRef,
} from './login-provider';

function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

export class HttpOAuthProvider implements LoginProvider {
  readonly name: ProviderName;
  readonly label: string;
  readonly appLabel: string;
  readonly allowPrefixes: LoginFacts['allowPrefixes'];
  readonly clientEnvKeys: LoginFacts['clientEnvKeys'];

  constructor(
    facts: LoginFacts,
    private readonly endpoints: Endpoints,
    private readonly serverToken: string,
    private readonly clock: Clock,
    private readonly apps: AppSource,
    private readonly appFlowOf?: () => AppFlow,
  ) {
    this.name = facts.name;
    this.label = facts.label;
    this.appLabel = facts.appLabel;
    this.allowPrefixes = facts.allowPrefixes;
    this.clientEnvKeys = facts.clientEnvKeys;
  }

  get appFlow(): AppFlow | undefined {
    return this.appFlowOf?.();
  }

  configured(): boolean {
    return this.apps.credentials(this.name) !== null;
  }

  connects(): boolean {
    return this.apps.connects(this.name);
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
    return this.identityOf(
      headers,
      await this.userOf(headers),
      this.connects()
        ? {
            accessToken: granted.access_token,
            refreshToken: granted.refresh_token ?? '',
            expiresIn: granted.expires_in,
          }
        : undefined,
    );
  }

  async identifyToken(token: string): Promise<Identity | null> {
    const headers = this.endpoints.userHeaders(token);
    const response = await request(this.clock, `${this.endpoints.api}${this.endpoints.user.path}`, headers, []);
    if (response.status === 401 || response.status === 403) {
      return null;
    }
    if (response.status >= 400) {
      throw new SwarmloopError(`${this.name} answered ${response.status}`);
    }
    const person = JSON.parse(response.body.toString('utf8')) as Record<string, unknown>;
    return this.identityOf(headers, person, { accessToken: token, refreshToken: '' });
  }

  async tokenOwner(): Promise<string | null> {
    if (this.serverToken === '') {
      return null;
    }
    return text((await this.userOf(this.endpoints.userHeaders(this.serverToken)))[this.endpoints.user.field]);
  }

  /** Asks the host about the repositories a few at a time and stops at the first one the person can push to. */
  async canPush(token: string, repos: RepoRef[]): Promise<boolean> {
    const headers = this.endpoints.userHeaders(token);
    const pushes = async (repo: RepoRef): Promise<boolean> => {
      const response = await request(this.clock, `${this.endpoints.api}${this.endpoints.repoPath(repo)}`, headers, []);
      if (response.status === 403 || response.status === 404) {
        return false;
      }
      if (response.status >= 400) {
        throw new SwarmloopError(`${this.name} answered ${response.status}`);
      }
      return this.endpoints.pushes(JSON.parse(response.body.toString('utf8')) as Record<string, unknown>);
    };
    for (let at = 0; at < repos.length; at += PUSH_CHECKS_AT_ONCE) {
      const answers = await Promise.all(repos.slice(at, at + PUSH_CHECKS_AT_ONCE).map(pushes));
      if (answers.includes(true)) {
        return true;
      }
    }
    return false;
  }

  private credentials(): AppCredentials {
    const app = this.apps.credentials(this.name);
    if (!app) {
      throw new SwarmloopError(`${this.name} login is not configured`);
    }
    return app;
  }

  /** The person the token belongs to, with the orgs or groups they are in. */
  private async identityOf(
    headers: Record<string, string>,
    person: Record<string, unknown>,
    grant: Grant | undefined,
  ): Promise<Identity> {
    const { groups } = this.endpoints;
    return {
      user: text(person[this.endpoints.user.field]),
      ...(text(person.avatar_url) ? { avatarUrl: text(person.avatar_url) } : {}),
      groups: names(await this.send(`${this.endpoints.api}${groups.path}`, headers), groups.field),
      ...(grant ? { grant } : {}),
    };
  }

  private async userOf(headers: Record<string, string>): Promise<Record<string, unknown>> {
    return (await this.send(`${this.endpoints.api}${this.endpoints.user.path}`, headers)) as Record<string, unknown>;
  }

  private async send(url: string, headers: Record<string, string>, init?: { method: string; body: string }) {
    const response = await request(this.clock, url, headers, [], init);
    if (response.status >= 400) {
      throw new SwarmloopError(`${this.name} answered ${response.status}`);
    }
    return JSON.parse(response.body.toString('utf8')) as unknown;
  }
}

/** How many repositories one login asks the host about at the same time. */
const PUSH_CHECKS_AT_ONCE = 5;

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

const names = (rows: unknown, field: string): string[] =>
  (Array.isArray(rows) ? rows : []).map((row) => text((row as Record<string, unknown>)[field]));
