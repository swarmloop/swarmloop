import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { registerSecretSource } from '../core/secret-sources';
import { isLoopback } from './bind-check';
import { PersonalTokens } from './personal-tokens.service';
import type { LoginProvider } from '../integrations/code-host/login-provider';
import { SessionService, sessionIdOf } from './session.service';

export const OAUTH_PROVIDERS = 'OAUTH_PROVIDERS';

/** How a request proved who it is. */
export type Via = 'session' | 'token';

export interface Credentials {
  cookie?: string;
  authorization?: string;
}

/** Who is acting: a session or a personal token. Nothing else is let in. */
@Injectable()
export class AuthService implements OnModuleInit, OnModuleDestroy {
  private readonly envToken: string | undefined;
  private unregisterSecrets: (() => void) | undefined;
  private readonly publicUrl: string;

  constructor(
    config: AppConfig,
    private readonly sessions: SessionService,
    private readonly tokens: PersonalTokens,
    @Inject(OAUTH_PROVIDERS) private readonly providers: LoginProvider[],
  ) {
    this.publicUrl = config.env.SWARMLOOP_PUBLIC_URL;
    this.envToken = config.env.SWARMLOOP_TOKEN || undefined;
  }

  onModuleInit(): void {
    this.unregisterSecrets = registerSecretSource(() => this.secrets());
  }

  onModuleDestroy(): void {
    this.unregisterSecrets?.();
  }

  /** The `SWARMLOOP_TOKEN` value, when set: it must never reach a log. */
  secrets(): string[] {
    return this.envToken ? [this.envToken] : [];
  }

  /** Every provider, configured or not. */
  all(): LoginProvider[] {
    return this.providers;
  }

  configured(): LoginProvider[] {
    return this.providers.filter((provider) => provider.configured());
  }

  /** The login of a live session, else the person a Bearer personal token acts for, or null. */
  async actorOf(credentials: Credentials): Promise<string | null> {
    return (await this.resolve(credentials)).actor;
  }

  async check(credentials: Credentials): Promise<{ allowed: boolean; actor: string | null; via: Via | null }> {
    const { actor, via } = await this.resolve(credentials);
    return { allowed: actor !== null, actor, via };
  }

  private async resolve(credentials: Credentials): Promise<{ actor: string | null; via: Via | null }> {
    const session = (await this.sessions.find(sessionIdOf(credentials.cookie)))?.user;
    if (session) {
      return { actor: session, via: 'session' };
    }
    const bearer = /^Bearer (.+)$/i.exec(credentials.authorization ?? '')?.[1];
    const person = bearer ? await this.tokens.personOf(bearer) : null;
    return person ? { actor: person, via: 'token' } : { actor: null, via: null };
  }

  /** The first-run routes answer while no login exists, and only to this machine. Once a login exists nobody can replace the app. */
  firstRunOpen(request: { host?: string; 'x-forwarded-host'?: string }): boolean {
    return this.configured().length === 0 && this.onThisMachine(request);
  }

  /** True when the request's host and the public URL are both loopback. */
  onThisMachine(request: { host?: string; 'x-forwarded-host'?: string }): boolean {
    return isLoopback(request['x-forwarded-host'] ?? request.host ?? '') && isLoopback(new URL(this.publicUrl).host);
  }
}
