import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppConfig } from '../config/env';
import { HostAppEntity } from '../history/connection-entities';
import type { AppCredentials, AppSource, ProviderName } from './oauth-provider';
import { SecretBox } from './secret-box';

/** A GitHub App (all fields) or a GitLab application (client id and secret). */
interface HostApp {
  host: ProviderName;
  appId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  /** The login of the person who made the app, or `machine`. Null for an app made earlier. */
  madeBy: string | null;
}

/** The app of each host: the one Connect stored, encrypted, else the OAuth app of the environment. */
@Injectable()
export class HostAppsService implements AppSource, OnModuleInit {
  private readonly apps = new Map<string, HostApp>();

  constructor(
    private readonly config: AppConfig,
    private readonly box: SecretBox,
    @InjectRepository(HostAppEntity) private readonly rows: Repository<HostAppEntity>,
  ) {}

  async onModuleInit(): Promise<void> {
    for (const row of await this.rows.find()) {
      this.apps.set(row.host, {
        host: row.host as ProviderName,
        appId: row.appId,
        slug: row.slug,
        clientId: row.clientId,
        clientSecret: this.box.open(row.clientSecret),
        privateKey: row.privateKey ? this.box.open(row.privateKey) : '',
        madeBy: row.madeBy,
      });
    }
  }

  /** The stored app, or null. The secret leaves this service only for the login and the token refresh. */
  find(host: ProviderName): HostApp | null {
    return this.apps.get(host) ?? null;
  }

  async save(app: HostApp): Promise<void> {
    await this.rows.save({
      host: app.host,
      appId: app.appId,
      slug: app.slug,
      clientId: app.clientId,
      clientSecret: this.box.seal(app.clientSecret),
      privateKey: app.privateKey ? this.box.seal(app.privateKey) : '',
      madeBy: app.madeBy,
    });
    this.apps.set(app.host, app);
  }

  credentials(host: ProviderName): AppCredentials | null {
    const stored = this.find(host);
    if (stored) {
      return { clientId: stored.clientId, clientSecret: stored.clientSecret };
    }
    const { env } = this.config;
    const [clientId, clientSecret] =
      host === 'github'
        ? [env.GITHUB_OAUTH_CLIENT_ID, env.GITHUB_OAUTH_CLIENT_SECRET]
        : [env.GITLAB_OAUTH_CLIENT_ID, env.GITLAB_OAUTH_CLIENT_SECRET];
    return clientId !== '' && clientSecret !== '' ? { clientId, clientSecret } : null;
  }

  /** One authorization signs in and connects for a stored GitHub App and for GitLab. A plain GitHub OAuth app keeps nothing. */
  connects(host: ProviderName): boolean {
    return host === 'gitlab' || this.find(host) !== null;
  }
}
