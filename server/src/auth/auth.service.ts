import { Inject, Injectable } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { resolveRepoRoot } from '../config/repo-root';
import { machineToken, tokenMatches } from './machine-token';
import type { OAuthProvider } from './oauth-provider';
import { SessionService, sessionIdOf } from './session.service';

export const OAUTH_PROVIDERS = 'OAUTH_PROVIDERS';

export interface Credentials {
  cookie?: string;
  authorization?: string;
}

/** Who is acting: a session or the machine token. With no OAuth provider configured everyone is let in, as before. */
@Injectable()
export class AuthService {
  private readonly token: string;

  constructor(
    config: AppConfig,
    private readonly sessions: SessionService,
    @Inject(OAUTH_PROVIDERS) private readonly providers: OAuthProvider[],
  ) {
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
    return { allowed: actor !== null || this.configured().length === 0, actor };
  }
}
