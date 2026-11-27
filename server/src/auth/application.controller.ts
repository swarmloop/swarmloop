import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  NotFoundException,
  Post,
  Req,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AppConfig } from '../config/env';
import { personLabel } from '../contract/people';
import { AppReplacePolicy } from './app-replace-policy';
import { AuthService, type Credentials } from './auth.service';
import { callbackUrl } from './callback-url';
import { ConnectionsService } from './connections.service';
import { FIRST_RUN_MAKER, takesOverApp } from './first-run-maker';
import { HostAppsService } from './host-apps.service';
import { applicationRoutes, routeHost } from './host-routes';
import { Public } from './public.decorator';
import type { LoginProvider } from '../integrations/code-host/login-provider';

type RoutedRequest = { headers: Credentials & { host?: string }; route?: { path?: string } };

/** The OAuth application of a host that stores one: made on first run, replaced by its maker or an admin. */
@Public()
@Controller('auth')
export class ApplicationController {
  constructor(
    private readonly config: AppConfig,
    private readonly auth: AuthService,
    private readonly apps: HostAppsService,
    private readonly connections: ConnectionsService,
    private readonly policy: AppReplacePolicy,
  ) {}

  /** Stores the application once the host has accepted it, and drops the connections the old one issued. */
  @Post(applicationRoutes('application'))
  async storeApplication(
    @Body() body: { clientId?: string; clientSecret?: string },
    @Req() request: RoutedRequest,
  ): Promise<{ ok: true }> {
    const provider = this.anyProvider(routeHost(request));
    const clientId = body.clientId?.trim() ?? '';
    const clientSecret = body.clientSecret?.trim() ?? '';
    if (!clientId || !clientSecret) {
      throw new BadRequestException('clientId and clientSecret are required');
    }
    const actor = await this.actorWhoMay(provider, request.headers);
    const accepted = await provider
      .checkApp({ clientId, clientSecret }, callbackUrl(this.config, provider.name))
      .catch((error: unknown) => {
        throw new BadGatewayException(error instanceof Error ? error.message : `${provider.label} did not answer`);
      });
    if (!accepted) {
      throw new UnprocessableEntityException(
        `${provider.label} did not accept this ${provider.appLabel} ID and Secret. Check both fields.`,
      );
    }
    const replaced = this.apps.find(provider.name) !== null;
    await this.apps.save({
      host: provider.name,
      appId: '',
      slug: '',
      clientId,
      clientSecret,
      privateKey: '',
      madeBy: actor ?? FIRST_RUN_MAKER,
    });
    if (replaced) {
      await this.connections.disconnectGrants(provider.name);
    }
    return { ok: true };
  }

  /** The signed-in person who replaces the application, or null when first run or this machine may store it. Anyone else is refused. */
  private async actorWhoMay(provider: LoginProvider, headers: RoutedRequest['headers']): Promise<string | null> {
    if (this.auth.firstRunOpen(headers)) {
      return null;
    }
    const stored = this.apps.find(provider.name);
    if (stored) {
      const { actor } = await this.auth.check(headers);
      if (actor && (await this.policy.mayReplace(actor, stored.madeBy))) {
        return actor;
      }
      if (this.auth.onThisMachine(headers) && takesOverApp(stored.madeBy)) {
        return null;
      }
    }
    throw new ForbiddenException(this.refusal(provider, stored?.madeBy));
  }

  private refusal(provider: LoginProvider, madeBy: string | null | undefined): string {
    if (madeBy !== undefined) {
      const maker = madeBy === FIRST_RUN_MAKER ? null : madeBy;
      return `${maker ? `Only ${personLabel(maker)} or an admin` : 'Only an admin'} can replace this application. Sign in with a token, then use Connections.`;
    }
    const { env } = this.config;
    const { clientId, clientSecret } = provider.clientEnvKeys;
    if (env[clientId] && env[clientSecret]) {
      return `This ${provider.label} application comes from ${clientId} and ${clientSecret}: change them in .env and restart the server.`;
    }
    return 'a login exists, or this is not the machine the server runs on';
  }

  private anyProvider(name: string): LoginProvider {
    const provider = this.auth.all().find((candidate) => candidate.name === name);
    if (!provider) {
      throw new NotFoundException(`${name} login is not configured`);
    }
    return provider;
  }
}
