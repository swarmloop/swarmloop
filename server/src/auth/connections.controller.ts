import { BadRequestException, Controller, Delete, ForbiddenException, Get, Param, Post, Res } from '@nestjs/common';
import { AppConfig } from '../config/env';
import type { ConnectionView, ConnectionsView } from '../contract/api';
import { Actor } from './actor.decorator';
import { CheckoutRepos } from './checkout-repos';
import { ConnectionsService } from './connections.service';
import { startState, type CookieResponse } from './cookies';
import { GithubAppService } from './github-app.service';
import { HostAppsService } from './host-apps.service';
import { LoginStates } from './login-states';
import type { ProviderName } from './oauth-provider';

const HOSTS: readonly ProviderName[] = ['github', 'gitlab'];

/** The Connections page: what each host is set up with, and the signed-in person's own connection to it. */
@Controller('connections')
export class ConnectionsController {
  constructor(
    private readonly config: AppConfig,
    private readonly apps: HostAppsService,
    private readonly connections: ConnectionsService,
    private readonly githubApp: GithubAppService,
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

  /** The GitHub page where the person adds repositories to the installation. */
  @Post(':host/install')
  install(@Param('host') host: string, @Res({ passthrough: true }) response: CookieResponse): { url: string } {
    const app = this.host(host) === 'github' ? this.apps.find('github') : null;
    if (!app) {
      throw new BadRequestException('there is no GitHub App to install');
    }
    return {
      url: this.githubApp.installUrl(app.slug, startState(this.states, this.config, 'github', response, false).state),
    };
  }

  /** Forgets the stored GitHub App and the connections made through it so the first-run form comes back. Only its maker, or the machine token. The app on GitHub stays. */
  @Delete('github/app')
  async replaceApp(@Actor() actor: string | null): Promise<{ ok: true }> {
    const app = this.apps.find('github');
    if (!app) {
      throw new BadRequestException('there is no GitHub App to replace');
    }
    if (actor !== 'machine' && actor !== app.madeBy) {
      throw new ForbiddenException(`Only ${app.madeBy ?? 'the machine token'} can replace this app`);
    }
    await this.apps.forget('github');
    // Their tokens belong to the old app: the new one cannot refresh them, and they would keep the install step shut.
    await this.connections.disconnectAll('github');
    return { ok: true };
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

  private settingsUrl(host: ProviderName, slug: string | undefined): string | null {
    return host === 'github' && slug
      ? `${new URL(this.config.env.GITHUB_BASE_URL || 'https://github.com').origin}/settings/apps/${encodeURIComponent(slug)}`
      : null;
  }

  /** The owners of the checkouts, when the installation covers none of them. */
  private async missingOwners(installed: string[]): Promise<string[]> {
    const have = new Set(installed.map((name) => name.toLowerCase()));
    const checkouts = (await this.repos.list().catch(() => [])).filter((repo) => repo.host === 'github');
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
    const repositories =
      host === 'github' && health ? await this.connections.repositories(actor as string).catch(() => []) : [];
    return {
      host,
      app: credentials
        ? {
            name: stored?.slug || (host === 'github' ? 'OAuth app' : 'OAuth application'),
            clientId: credentials.clientId,
            madeBy: stored?.madeBy ?? null,
            settingsUrl: this.settingsUrl(host, stored?.slug),
          }
        : null,
      account: health?.login ?? null,
      repositories,
      missingOwners: host === 'github' && health ? await this.missingOwners(repositories) : [],
      selection: health?.selection === 'selected' ? 'selected' : health?.selection === 'all' ? 'all' : null,
      health: health && { status: health.status, expiresAt: health.expiresAt, refreshedAt: health.refreshedAt },
    };
  }
}
