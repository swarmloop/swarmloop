import { Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppConfig } from '../config/env';
import { HostAppEntity } from '../history/connection-entities';
import {
  type AppCredentials,
  type AppSource,
  type HostAppStore,
  type ProviderName,
  type StoredApp,
} from '../integrations/code-host/login-provider';
import { codeHostAdapters } from '../integrations/code-host/code-host-adapters';
import { SecretBox } from './secret-box';

/** The app of each host: the one Connect stored, encrypted, else the OAuth app of the environment. */
@Injectable()
export class HostAppsService implements AppSource, HostAppStore, OnModuleInit {
  private readonly apps = new Map<string, StoredApp>();

  constructor(
    private readonly config: AppConfig,
    private readonly box: SecretBox,
    @InjectRepository(HostAppEntity) private readonly rows: Repository<HostAppEntity>,
  ) {}

  async onModuleInit(): Promise<void> {
    for (const row of await this.rows.find()) {
      this.apps.set(row.host, {
        host: row.host,
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
  find(host: ProviderName): StoredApp | null {
    return this.apps.get(host) ?? null;
  }

  async save(app: StoredApp): Promise<void> {
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
    const keys = codeHostAdapters().find((adapter) => adapter.name === host)?.clientEnvKeys;
    const clientId = keys ? env[keys.clientId] : '';
    const clientSecret = keys ? env[keys.clientSecret] : '';
    return clientId !== '' && clientSecret !== '' ? { clientId, clientSecret } : null;
  }

  /** One authorization signs in and connects for a stored app and for a host that always keeps the tokens. A plain OAuth app keeps nothing. */
  connects(host: ProviderName): boolean {
    const adapter = codeHostAdapters().find((item) => item.name === host);
    return (adapter?.keepsTokensWithoutApp ?? false) || this.find(host) !== null;
  }
}
