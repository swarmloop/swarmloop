import { Inject, Injectable } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import { isLoopback } from './bind-check';
import { machineToken, tokenMatches } from './machine-token';
import type { OAuthProvider } from './oauth-provider';
import { SessionService, sessionIdOf } from './session.service';

export const OAUTH_PROVIDERS = 'OAUTH_PROVIDERS';

export interface Credentials {
  cookie?: string;
  authorization?: string;
}

/** Who is acting: a session or the machine token. Nothing else is let in. */
@Injectable()
export class AuthService {
  private readonly token: string;
  private readonly publicUrl: string;

  constructor(
    config: AppConfig,
    private readonly sessions: SessionService,
    @Inject(OAUTH_PROVIDERS) private readonly providers: OAuthProvider[],
  ) {
    this.publicUrl = config.env.SWARMLOOP_PUBLIC_URL;
    this.token = machineToken(resolveRepoRoot(config.env.SWARMLOOP_ROOT, __dirname), config.env.SWARMLOOP_TOKEN);
  }

  configured(): OAuthProvider[] {
    return this.providers.filter((provider) => provider.configured());
  }

  /** The login name of a live session, `machine` for the token, or null. */
  async actorOf(credentials: Credentials): Promise<string | null> {
    const bearer = /^Bearer (.+)$/i.exec(credentials.authorization ?? '')?.[1];
    if (bearer && tokenMatches(this.token, bearer)) {
      return 'machine';
    }
    return (await this.sessions.find(sessionIdOf(credentials.cookie)))?.user ?? null;
  }

  async check(credentials: Credentials): Promise<{ allowed: boolean; actor: string | null }> {
    const actor = await this.actorOf(credentials);
    return { allowed: actor !== null, actor };
  }

  /**
   * The first-run routes answer while no login exists, and only to this machine: a request whose host and the public
   * URL are loopback, or one that holds the machine token. Once a login exists nobody can replace the app.
   */
  async firstRunOpen(request: Credentials & { host?: string; 'x-forwarded-host'?: string }): Promise<boolean> {
    if (this.configured().length > 0) {
      return false;
    }
    if ((await this.actorOf(request)) === 'machine') {
      return true;
    }
    return this.onThisMachine(request);
  }

  /** True when the request's host and the public URL are both loopback. */
  onThisMachine(request: { host?: string; 'x-forwarded-host'?: string }): boolean {
    return isLoopback(request['x-forwarded-host'] ?? request.host ?? '') && isLoopback(new URL(this.publicUrl).host);
  }
}
