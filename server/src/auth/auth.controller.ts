import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { AppConfig } from '../config/env';
import { decide, parseAllow } from './allow-list';
import { AuthService, type Credentials } from './auth.service';
import { CheckoutRepos } from './checkout-repos';
import { ConnectionsService } from './connections.service';
import { cookieOptions, startState, STATE_COOKIE, type CookieResponse } from './cookies';
import { GithubAppService, type ManifestForm } from './github-app.service';
import { HostAppsService } from './host-apps.service';
import { LoginStates } from './login-states';
import type { MeView } from '../contract/api';
import type { OAuthProvider, ProviderName } from './oauth-provider';
import { Public } from './public.decorator';
import { cookieValue, SESSION_COOKIE, SESSION_DAYS, SessionService, sessionIdOf } from './session.service';

type Headers = Credentials & { host?: string };

/** Login with GitHub or GitLab, and the first-run routes that make the app. The session cookie is the only thing that outlives the login call. */
@Public()
@Controller('auth')
export class AuthController {
  constructor(
    private readonly config: AppConfig,
    private readonly auth: AuthService,
    private readonly states: LoginStates,
    private readonly sessions: SessionService,
    private readonly connections: ConnectionsService,
    private readonly apps: HostAppsService,
    private readonly githubApp: GithubAppService,
    private readonly repos: CheckoutRepos,
  ) {}

  /** `login` is false until the first app is connected: the dashboard then shows the first-run screen. */
  @Get('first-run')
  firstRun(): { login: boolean } {
    return { login: this.auth.configured().length > 0 };
  }

  /** First run only: the manifest of the GitHub App, and the GitHub page it is posted to. */
  @Get('github/manifest')
  async manifest(
    @Query('org') org: string | undefined,
    @Req() request: { headers: Headers },
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<ManifestForm> {
    await this.assertFirstRun(request.headers);
    const { state } = this.startState('github', response);
    return this.githubApp.manifest(org?.trim() || undefined, state);
  }

  /** First run only: who owns the repositories this server works on, to fill in the owner of the app. */
  @Get('github/owner')
  async owner(@Req() request: { headers: Headers }): Promise<{ owner: string; others: string[] }> {
    await this.assertFirstRun(request.headers);
    const [owner = '', ...others] = await this.repos.owners('github');
    return { owner, others };
  }

  /** The GitHub page where the person installs the app they just made, until the first person has logged in. */
  @Get('github/install')
  async install(
    @Req() request: { headers: Headers },
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<{ url: string }> {
    const onMachine =
      (await this.auth.actorOf(request.headers)) === 'machine' || this.auth.onThisMachine(request.headers);
    if (!onMachine || (await this.connections.anyConnected())) {
      throw new ForbiddenException('a login exists, or this is not the machine the server runs on');
    }
    const app = this.apps.find('github');
    if (!app) {
      throw new BadRequestException('there is no GitHub App to install');
    }
    return { url: this.githubApp.installUrl(app.slug, this.startState('github', response, false).state) };
  }

  /** First run only: where GitHub redirects after the manifest. The app is stored, then the person installs and authorizes it. */
  @Get('github/created')
  async created(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() request: { headers: Headers },
    @Res() response: CookieResponse,
  ): Promise<void> {
    await this.assertFirstRun(request.headers);
    if (!code || !this.takeState(request.headers, state, response)) {
      throw new BadRequestException('the app was not made from here or the link has expired: try again');
    }
    // First run opens only on this machine or with the machine token, so there is no person to name yet.
    await this.githubApp.convert(code, 'machine').catch((error: unknown) => {
      throw new BadGatewayException(error instanceof Error ? error.message : 'github did not make the app');
    });
    response.redirect('/login?install=1');
  }

  /** First run only: the OAuth application of a GitLab instance, stored encrypted. */
  @Post('gitlab/application')
  async gitlabApplication(
    @Body() body: { clientId?: string; clientSecret?: string },
    @Req() request: { headers: Headers },
  ): Promise<{ ok: true }> {
    await this.assertFirstRun(request.headers);
    const clientId = body.clientId?.trim() ?? '';
    const clientSecret = body.clientSecret?.trim() ?? '';
    if (!clientId || !clientSecret) {
      throw new BadRequestException('clientId and clientSecret are required');
    }
    await this.apps.save({
      host: 'gitlab',
      appId: '',
      slug: '',
      clientId,
      clientSecret,
      privateKey: '',
      madeBy: 'machine',
    });
    return { ok: true };
  }

  @Get('providers')
  providers(): { providers: string[] } {
    return { providers: this.auth.configured().map((provider) => provider.name) };
  }

  @Get('me')
  async me(@Req() request: { headers: { cookie?: string } }): Promise<MeView> {
    const session = await this.sessions.find(sessionIdOf(request.headers.cookie));
    return session
      ? { user: session.user, provider: session.provider, avatarUrl: session.avatarUrl ?? null }
      : { user: null };
  }

  @Get(':provider/login')
  login(@Param('provider') name: string, @Res() response: CookieResponse): void {
    const provider = this.provider(name);
    const { state, verifier } = this.startState(provider.name, response);
    response.redirect(provider.authorizeUrl(this.redirectUri(provider), state, verifier));
  }

  @Get(':provider/callback')
  async callback(
    @Param('provider') name: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('installation_id') installationId: string | undefined,
    @Query('setup_action') setupAction: string | undefined,
    @Req() request: { headers: Headers },
    @Res() response: CookieResponse,
  ): Promise<void> {
    const provider = this.provider(name);
    if (provider.name === 'github' && setupAction === 'install' && installationId && !state && !code) {
      // An install started on GitHub's own page: nobody is signed in by it, the person logs in next.
      const account = (await this.githubApp.installedAccount(installationId)) ?? '';
      response.redirect(`/login?installed=${encodeURIComponent(account)}`);
      return;
    }
    const pending = this.takeState(request.headers, state, response);
    if (!pending || pending.provider !== provider.name || !code) {
      throw new BadRequestException('the login did not start here or has expired: try again');
    }
    const identity = await provider
      .identify(code, this.redirectUri(provider), pending.verifier)
      .catch((error: unknown) => {
        throw new BadGatewayException(error instanceof Error ? error.message : `${provider.name} login failed`);
      });
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
    const verdict = await decide(
      parseAllow(this.config.env.SWARMLOOP_ALLOW),
      { provider: provider.name, ...identity },
      async () =>
        (await provider.tokenOwner()) ??
        ((await this.connections.ownsOrFirst(provider.name, identity.user, this.auth.onThisMachine(request.headers)))
          ? identity.user
          : null),
      push,
    );
    if (!verdict.allowed) {
      throw new ForbiddenException(
        verdict.message ?? `${provider.name}:${identity.user} may not log in: ${verdict.reason}`,
      );
    }
    if (identity.grant) {
      // The first person to sign in through an app made on this machine is the one who made it.
      const app = this.apps.find(provider.name);
      if (app?.madeBy === 'machine' && (await this.connections.noneOn(provider.name))) {
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
    response.redirect('/');
  }

  @Post('logout')
  async logout(
    @Req() request: { headers: { cookie?: string } },
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<{ ok: true }> {
    const id = sessionIdOf(request.headers.cookie);
    if (id) {
      await this.sessions.delete(id);
    }
    response.clearCookie(SESSION_COOKIE, { ...cookieOptions(this.config), path: '/' });
    return { ok: true };
  }

  private async assertFirstRun(headers: Headers): Promise<void> {
    if (!(await this.auth.firstRunOpen(headers))) {
      throw new ForbiddenException('a login exists, or this is not the machine the server runs on');
    }
  }

  private startState(provider: ProviderName, response: CookieResponse, pkce = true) {
    return startState(this.states, this.config, provider, response, pkce);
  }

  /** The login for `state`, once, when the browser holds the same state. */
  private takeState(headers: { cookie?: string }, state: string | undefined, response: CookieResponse) {
    const bound = cookieValue(headers.cookie, STATE_COOKIE);
    const pending = state && bound === state ? this.states.take(state) : null;
    response.clearCookie(STATE_COOKIE, { ...cookieOptions(this.config), path: '/auth' });
    return pending;
  }

  private provider(name: string): OAuthProvider {
    const provider = this.auth.configured().find((candidate) => candidate.name === name);
    if (!provider) {
      throw new NotFoundException(`${name} login is not configured`);
    }
    return provider;
  }

  private redirectUri(provider: OAuthProvider): string {
    return `${this.config.env.SWARMLOOP_PUBLIC_URL.replace(/\/$/, '')}/auth/${provider.name}/callback`;
  }
}
