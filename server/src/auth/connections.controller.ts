import {
  BadRequestException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { AppConfig } from '../config/env';
import type { ConnectionView, ConnectionsView } from '../contract/api';
import { Actor } from './actor.decorator';
import { CheckoutRepos } from './checkout-repos';
import { ConnectionsService } from './connections.service';
import { startState, type CookieResponse } from './cookies';
import { AuthService } from './auth.service';
import { appFlowApps, appFlowRoutes, routeHost } from './host-routes';
import { HostAppsService } from './host-apps.service';
import { LoginStates } from './login-states';
import { codeHostAdapters } from '../integrations/code-host/code-host-adapters';
import type {
  AppFlow,
  Endpoints,
  LoginProvider,
  ManifestForm,
  ProviderName,
} from '../integrations/code-host/login-provider';

const HOSTS: readonly ProviderName[] = codeHostAdapters().map((adapter) => adapter.name);

/** The Connections page: what each host is set up with, and the signed-in person's own connection to it. */
@Controller('connections')
export class ConnectionsController {
  constructor(
    private readonly config: AppConfig,
    private readonly apps: HostAppsService,
    private readonly connections: ConnectionsService,
    private readonly auth: AuthService,
    private readonly states: LoginStates,
    private readonly repos: CheckoutRepos,
  ) {}

  @Get()
  async list(@Actor() actor: string | null): Promise<ConnectionsView> {
    return { connections: await Promise.all(HOSTS.map((host) => this.view(host, actor))) };
  }

  /** Reconnecting is signing in again: the login of the host also keeps the tokens. */
  @Post(':host/reconnect')
  reconnect(@Param('host') host: string): { url: string } {
    return { url: `/auth/${this.host(host)}/login` };
  }

  /** The host page where the person adds repositories to the installation. */
  @Post(':host/install')
  install(@Param('host') host: string, @Res({ passthrough: true }) response: CookieResponse): { url: string } {
    const provider = this.auth.all().find((candidate) => candidate.name === this.host(host));
    const flow = provider?.appFlow;
    const app = provider && flow ? this.apps.find(provider.name) : null;
    if (!provider || !flow || !app) {
      throw new BadRequestException(`there is no ${appFlowApps()} to install`);
    }
    return {
      url: flow.installUrl(app.slug, startState(this.states, this.config, provider.name, response, false).state),
    };
  }

  /** Starts the manifest flow for a new app of the host. The old app and its connections stay until the host returns the new one. Only its maker, or the machine token. */
  @Post(appFlowRoutes('app'))
  async replaceApp(
    @Query('org') org: string | undefined,
    @Actor() actor: string | null,
    @Req() request: { route?: { path?: string } },
    @Res({ passthrough: true }) response: CookieResponse,
  ): Promise<ManifestForm> {
    const provider = this.flowProvider(routeHost(request));
    const app = this.apps.find(provider.name);
    if (!app) {
      throw new BadRequestException(`there is no ${provider.label} ${provider.appLabel} to replace`);
    }
    if (actor !== 'machine' && actor !== app.madeBy) {
      throw new ForbiddenException(`Only ${app.madeBy ?? 'the machine token'} can replace this app`);
    }
    const { state } = startState(this.states, this.config, provider.name, response, true, actor as string);
    return provider.appFlow.manifest(org?.trim() || (await this.repos.owners(provider.name).catch(() => []))[0], state);
  }

  @Delete(':host')
  async disconnect(@Param('host') host: string, @Actor() actor: string | null): Promise<{ ok: true }> {
    if (actor) {
      await this.connections.disconnect(this.host(host), actor);
    }
    return { ok: true };
  }

  private host(name: string): ProviderName {
    const host = HOSTS.find((candidate) => candidate === name);
    if (!host) {
      throw new BadRequestException(`${name} is not a code host`);
    }
    return host;
  }

  private flowProvider(host: string): LoginProvider & { appFlow: AppFlow } {
    const provider = this.auth.all().find((candidate) => candidate.name === host);
    if (!provider?.appFlow) {
      throw new BadRequestException(`${host} is not a code host`);
    }
    return provider as LoginProvider & { appFlow: AppFlow };
  }

  private endpoints(host: ProviderName): Endpoints {
    const adapter = codeHostAdapters().find((candidate) => candidate.name === host);
    if (!adapter) {
      throw new BadRequestException(`${host} is not a code host`);
    }
    return adapter.endpoints(this.config.env);
  }

  private settingsUrl(host: ProviderName, slug: string | undefined): string | null {
    const adapter = codeHostAdapters().find((candidate) => candidate.name === host);
    return adapter && this.endpoints(host).installs && slug
      ? `${new URL(this.config.env[adapter.baseKey] || `https://${adapter.publicHost}`).origin}/settings/apps/${encodeURIComponent(slug)}`
      : null;
  }

  /** The owners of the checkouts, when the installation covers none of them. */
  private async missingOwners(host: ProviderName, installed: string[]): Promise<string[]> {
    const have = new Set(installed.map((name) => name.toLowerCase()));
    const checkouts = (await this.repos.list().catch(() => [])).filter((repo) => repo.host === host);
    if (checkouts.some((repo) => have.has(`${repo.owner}/${repo.name}`.toLowerCase()))) {
      return [];
    }
    const owners = new Map(checkouts.map((repo) => [repo.owner.toLowerCase(), repo.owner]));
    return [...owners.values()];
  }

  private async view(host: ProviderName, actor: string | null): Promise<ConnectionView> {
    const stored = this.apps.find(host);
    const credentials = this.apps.credentials(host);
    const health = actor && actor !== 'machine' ? await this.connections.health(host, actor) : null;
    const { appLabel, installs } = this.endpoints(host);
    const mayReplace = installs && stored && (actor === 'machine' || actor === stored.madeBy);
    const repositories = installs && health ? await this.connections.repositories(actor as string).catch(() => []) : [];
    return {
      host,
      appLabel,
      installs,
      app: credentials
        ? {
            name: stored?.slug || `OAuth ${appLabel.toLowerCase()}`,
            clientId: credentials.clientId,
            madeBy: stored?.madeBy ?? null,
            settingsUrl: this.settingsUrl(host, stored?.slug),
          }
        : null,
      account: health?.login ?? null,
      repositories,
      missingOwners: installs && health ? await this.missingOwners(host, repositories) : [],
      selection: health?.selection === 'selected' ? 'selected' : health?.selection === 'all' ? 'all' : null,
      health: health && { status: health.status, expiresAt: health.expiresAt, refreshedAt: health.refreshedAt },
      connected: mayReplace ? await this.connections.loginsOn(host) : [],
    };
  }
}
