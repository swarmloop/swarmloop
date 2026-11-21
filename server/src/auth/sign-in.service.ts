import { BadGatewayException, Injectable } from '@nestjs/common';
import { AppConfig } from '../config/env';
import type { Identity, LoginProvider } from '../integrations/code-host/login-provider';
import { decide, parseAllow } from './allow-list';
import { AuthService, type Credentials } from './auth.service';
import { CheckoutRepos } from './checkout-repos';
import { ConnectionsService } from './connections.service';
import { cookieOptions, type CookieResponse } from './cookies';
import { takesOverApp } from './first-run-maker';
import { HostAppsService } from './host-apps.service';
import { problemUrl, safeNext } from './login-problem';
import { PeopleService } from './people.service';
import { SESSION_COOKIE, SESSION_DAYS, SessionService } from './session.service';

type Headers = Credentials & { host?: string };

/** What follows a host telling who the person is, whichever way it told: the decision, the connection and the session. */
@Injectable()
export class SignInService {
  constructor(
    private readonly config: AppConfig,
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly connections: ConnectionsService,
    private readonly apps: HostAppsService,
    private readonly repos: CheckoutRepos,
    private readonly people: PeopleService,
  ) {}

  /** Signs the person in and sets the session cookie. Returns where the browser goes: `next`, or the login page when the decision refuses. */
  async complete(
    provider: LoginProvider,
    identity: Identity,
    headers: Headers,
    response: CookieResponse,
    next: string | undefined,
  ): Promise<string> {
    const { grant } = identity;
    const push = grant
      ? async () => {
          const repos = (await this.repos.list()).filter((repo) => repo.host === provider.name);
          return provider.canPush(grant.accessToken, repos).catch((error: unknown) => {
            throw new BadGatewayException(
              error instanceof Error ? error.message : `${provider.name} push check failed`,
            );
          });
        }
      : undefined;
    const first = grant
      ? async () => this.auth.onThisMachine(headers) && (await this.connections.noneOn(provider.name))
      : undefined;
    const verdict = await decide(
      parseAllow(this.config.env.SWARMLOOP_ALLOW),
      { provider: provider.name, ...identity },
      async () =>
        (await provider.tokenOwner()) ??
        ((await this.connections.ownsOrFirst(provider.name, identity.user, this.auth.onThisMachine(headers)))
          ? identity.user
          : null),
      push,
      first,
    );
    if (!verdict.allowed) {
      return problemUrl('/login', 'refused', { host: provider.name, account: identity.user, reason: verdict.reason });
    }
    await this.people.seen(identity.user);
    if (identity.grant) {
      // The first person to sign in through an app made on this machine is the one who made it.
      const app = this.apps.find(provider.name);
      if (app && takesOverApp(app.madeBy) && (await this.connections.noneOn(provider.name))) {
        await this.apps.save({ ...app, madeBy: identity.user });
      }
      await this.connections.connect(provider.name, identity.user, identity.grant).catch((error: unknown) => {
        throw new BadGatewayException(error instanceof Error ? error.message : `${provider.name} connect failed`);
      });
    }
    const session = await this.sessions.create(identity.user, provider.name, identity.avatarUrl);
    response.cookie(SESSION_COOKIE, session.id, {
      ...cookieOptions(this.config),
      path: '/',
      maxAge: SESSION_DAYS * 24 * 3600 * 1000,
    });
    return safeNext(next);
  }
}
