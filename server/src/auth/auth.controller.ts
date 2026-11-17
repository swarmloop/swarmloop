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
import { appFlowRoutes, applicationRoutes, routeHost } from './host-routes';
import { HostAppsService } from './host-apps.service';
import { LoginStates } from './login-states';
import { problemOf, problemUrl, safeNext, type ProblemBase } from './login-problem';
import type { MeView } from '../contract/api';
import { FIRST_RUN_MAKER, takesOverApp } from './first-run-maker';
import { PeopleService } from './people.service';
import type { AppFlow, LoginProvider, ManifestForm, ProviderName } from '../integrations/code-host/login-provider';
import { Public } from './public.decorator';
import { cookieValue, SESSION_COOKIE, SESSION_DAYS, SessionService, sessionIdOf } from './session.service';

type Headers = Credentials & { host?: string };
type FlowProvider = LoginProvider & { appFlow: AppFlow };
type RoutedRequest = { headers: Headers; route?: { path?: string } };

/** Login with a code host, and the first-run routes that make the app. The session cookie is the only thing that outlives the login call. */
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
    private readonly repos: CheckoutRepos,
    private readonly people: PeopleService,
  ) {}

  /** `login` is false until the first app is connected: the dashboard then shows the first-run screen. */
  @Get('first-run')
  firstRun(): { login: boolean } {
    return { login: this.auth.configured().length > 0 };
  }

  /** First run only: the manifest of the host's app, and the host page it is posted to. */
  @Get(appFlowRoutes('manifest'))
  async manifest(
    @Query('org') org: string | undefined,
    @Req() request: RoutedRequest,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<ManifestForm> {
    this.assertFirstRun(request.headers);
    const provider = this.flowProvider(request);
    const { state } = this.startState(provider.name, response);
    return provider.appFlow.manifest(org?.trim() || undefined, state);
  }

  /** First run only: who owns the repositories this server works on, to fill in the owner of the app. */
  @Get(appFlowRoutes('owner'))
  async owner(@Req() request: RoutedRequest): Promise<{ owner: string; others: string[] }> {
    this.assertFirstRun(request.headers);
    const [owner = '', ...others] = await this.repos.owners(this.flowProvider(request).name);
    return { owner, others };
  }

  /** The host page where the person installs the app they just made, until the first person has logged in. */
  @Get(appFlowRoutes('install'))
  async install(
    @Req() request: RoutedRequest,
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<{ url: string }> {
    if (!this.auth.onThisMachine(request.headers) || (await this.connections.anyConnected())) {
      throw new ForbiddenException('a login exists, or this is not the machine the server runs on');
    }
    const provider = this.flowProvider(request);
    const app = this.apps.find(provider.name);
    if (!app) {
      throw new BadRequestException(`there is no ${provider.label} ${provider.appLabel} to install`);
    }
    return { url: provider.appFlow.installUrl(app.slug, this.startState(provider.name, response, false).state) };
  }

  /** Where the host redirects after the manifest, on first run or when the maker replaces the app. The app is stored, then the person installs and authorizes it. */
  @Get(appFlowRoutes('created'))
  async created(
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Req() request: RoutedRequest,
    @Res() response: CookieResponse,
  ): Promise<void> {
    const host = routeHost(request);
    const firstRun = this.auth.firstRunOpen(request.headers);
    const pending = this.takeState(request.headers, state, response);
    // First run opens only on this machine, so there is no person to name yet.
    const madeBy = firstRun ? (pending ? FIRST_RUN_MAKER : undefined) : pending?.replaceBy;
    const base = firstRun ? '/login' : await this.replaceBase(pending, request.headers);
    try {
      if (!code || madeBy === undefined) {
        throw new BadRequestException('the app was not made from here or the link has expired: try again');
      }
      const provider = this.flowProvider(request);
      const slug = await this.convertApp(provider, code, madeBy);
      if (firstRun) {
        response.redirect('/login?install=1');
        return;
      }
      // Their tokens belong to the old app: the new one cannot refresh them.
      await this.connections.disconnectAll(provider.name);
      response.redirect(provider.appFlow.installUrl(slug, this.startState(provider.name, response, false).state));
    } catch (error) {
      response.redirect(this.problemOrThrow(error, base, host));
    }
  }

  /** A replace flow returns to Connections, where the signed-in person is; anything else lands on the login page. */
  private async replaceBase(pending: { replaceBy?: string } | null, headers: Headers): Promise<ProblemBase> {
    const signedIn = !pending && (await this.sessions.find(sessionIdOf(headers.cookie))) !== null;
    return pending?.replaceBy !== undefined || signedIn ? '/connections' : '/login';
  }

  private problemOrThrow(error: unknown, base: ProblemBase, host: string): string {
    const url = problemOf(error, base, host);
    if (url === null) {
      throw error;
    }
    return url;
  }

  private convertApp(provider: FlowProvider, code: string, madeBy: string): Promise<string> {
    return provider.appFlow.convert(code, madeBy).catch((error: unknown) => {
      throw new BadGatewayException(error instanceof Error ? error.message : `${provider.name} did not make the app`);
    });
  }

  /** First run only: the OAuth application of a host instance, stored encrypted. */
  @Post(applicationRoutes('application'))
  async storeApplication(
    @Body() body: { clientId?: string; clientSecret?: string },
    @Req() request: RoutedRequest,
  ): Promise<{ ok: true }> {
    this.assertFirstRun(request.headers);
    const provider = this.anyProvider(routeHost(request));
    const clientId = body.clientId?.trim() ?? '';
    const clientSecret = body.clientSecret?.trim() ?? '';
    if (!clientId || !clientSecret) {
      throw new BadRequestException('clientId and clientSecret are required');
    }
    await this.apps.save({
      host: provider.name,
      appId: '',
      slug: '',
      clientId,
      clientSecret,
      privateKey: '',
      madeBy: FIRST_RUN_MAKER,
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
      ? {
          user: session.user,
          provider: session.provider,
          avatarUrl: session.avatarUrl ?? null,
          role: await this.people.roleOf(session.user),
          ...this.build(),
        }
      : { user: null, ...this.build() };
  }

  private build(): Pick<MeView, 'version' | 'sourceUrl'> {
    const { SWARMLOOP_BUILD_VERSION: version, SWARMLOOP_SOURCE_URL: source } = this.config.env;
    return { version: version || 'dev', sourceUrl: /^https?:\/\//.test(source) ? source : null };
  }

  @Get(':provider/login')
  login(
    @Param('provider') name: string,
    @Query('next') next: string | undefined,
    @Res() response: CookieResponse,
  ): void {
    const provider = this.provider(name);
    const { state, verifier } = this.startState(provider.name, response, true, safeNext(next));
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
    try {
      await this.signIn(name, code, state, installationId, setupAction, request.headers, response);
    } catch (error) {
      response.redirect(this.problemOrThrow(error, '/login', name));
    }
  }

  /** Every failure throws; `callback` turns it into a redirect to the login page. */
  private async signIn(
    name: string,
    code: string | undefined,
    state: string | undefined,
    installationId: string | undefined,
    setupAction: string | undefined,
    headers: Headers,
    response: CookieResponse,
  ): Promise<void> {
    const provider = this.provider(name);
    if (provider.appFlow && setupAction === 'install' && installationId && !state && !code) {
      // An install started on the host's own page: nobody is signed in by it, the person logs in next.
      const account = (await provider.appFlow.installedAccount(installationId)) ?? '';
      response.redirect(`/login?installed=${encodeURIComponent(account)}`);
      return;
    }
    const pending = this.takeState(headers, state, response);
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
      response.redirect(
        problemUrl('/login', 'refused', { host: provider.name, account: identity.user, reason: verdict.reason }),
      );
      return;
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
    response.redirect(safeNext(pending.next));
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

  private assertFirstRun(headers: Headers): void {
    if (!this.auth.firstRunOpen(headers)) {
      throw new ForbiddenException('a login exists, or this is not the machine the server runs on');
    }
  }

  private startState(provider: ProviderName, response: CookieResponse, pkce = true, next?: string) {
    return startState(this.states, this.config, provider, response, pkce, undefined, next);
  }

  /** The login for `state`, once, when the browser holds the same state. */
  private takeState(headers: { cookie?: string }, state: string | undefined, response: CookieResponse) {
    const bound = cookieValue(headers.cookie, STATE_COOKIE);
    const pending = state && bound === state ? this.states.take(state) : null;
    response.clearCookie(STATE_COOKIE, { ...cookieOptions(this.config), path: '/auth' });
    return pending;
  }

  private provider(name: string): LoginProvider {
    const provider = this.auth.configured().find((candidate) => candidate.name === name);
    if (!provider) {
      throw new NotFoundException(`${name} login is not configured`);
    }
    return provider;
  }

  private anyProvider(name: string): LoginProvider {
    const provider = this.auth.all().find((candidate) => candidate.name === name);
    if (!provider) {
      throw new NotFoundException(`${name} login is not configured`);
    }
    return provider;
  }

  /** The provider the matched route names, which must have an app flow. Looked up among all providers: first run has none configured. */
  private flowProvider(request: RoutedRequest): FlowProvider {
    const provider = this.anyProvider(routeHost(request));
    if (!provider.appFlow) {
      throw new NotFoundException(`${provider.name} login is not configured`);
    }
    return provider as FlowProvider;
  }

  private redirectUri(provider: LoginProvider): string {
    return `${this.config.env.SWARMLOOP_PUBLIC_URL.replace(/\/$/, '')}/auth/${provider.name}/callback`;
  }
}
