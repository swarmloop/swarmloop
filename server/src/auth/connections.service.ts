import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { GitAuthError, SwarmloopError } from '../core/swarmloop-error';
import { ConnectionEntity } from '../history/connection-entities';
import { request } from '../integrations/http';
import { HostAppsService } from './host-apps.service';
import { githubEndpoints, gitlabEndpoints, type Endpoints, type Grant, type ProviderName } from './oauth-provider';
import { SecretBox } from './secret-box';

/** A token is refreshed this long before it ends. */
const REFRESH_AHEAD_MS = 5 * 60 * 1000;

interface Installation {
  id: string;
  selection: string;
}

/** The health of one connection. It never holds a token. */
interface ConnectionHealth {
  login: string;
  status: 'ok' | 'broken';
  expiresAt: string | null;
  refreshedAt: string | null;
  installationId: string | null;
  selection: string | null;
}

const idOf = (host: string, login: string): string => `${host}:${login}`;

/** The tokens of each connected person, encrypted at rest and refreshed before they end. */
@Injectable()
export class ConnectionsService {
  private readonly refreshing = new Map<string, Promise<string>>();

  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly box: SecretBox,
    private readonly apps: HostAppsService,
    @InjectRepository(ConnectionEntity) private readonly rows: Repository<ConnectionEntity>,
  ) {}

  /** Keeps the grant of a person, and on GitHub the installation of the app they can use. Marks the connection ok. */
  async connect(host: ProviderName, login: string, grant: Grant): Promise<void> {
    const found = host === 'github' ? await this.installationOf(grant.accessToken) : null;
    await this.rows.save(this.row(host, login, grant, found));
  }

  async health(host: ProviderName, login: string): Promise<ConnectionHealth | null> {
    const row = await this.rows.findOneBy({ id: idOf(host, login) });
    return row && this.healthOf(row);
  }

  /** True when this person is connected on the host, or, on this machine only, nobody is yet: the first person to sign in with a new app owns it. */
  async ownsOrFirst(host: ProviderName, login: string, onThisMachine: boolean): Promise<boolean> {
    return (
      (await this.rows.countBy({ id: idOf(host, login) })) > 0 ||
      (onThisMachine && (await this.rows.countBy({ host })) === 0)
    );
  }

  /** True when any person has a working connection. */
  async anyConnected(): Promise<boolean> {
    return (await this.rows.countBy({ status: 'ok' })) > 0;
  }

  /** True when the person is connected somewhere and none of their connections needs a reconnect. */
  async isHealthy(login: string): Promise<boolean> {
    return (
      (await this.rows.countBy({ login, status: 'ok' })) > 0 &&
      (await this.rows.countBy({ login, status: 'broken' })) === 0
    );
  }

  async disconnect(host: ProviderName, login: string): Promise<void> {
    await this.rows.delete({ id: idOf(host, login) });
  }

  /** The access token of a person on a host, refreshed when it is about to end. Null when the person has no connection. Only the code-host layer reads it. */
  async tokenFor(host: ProviderName, login: string): Promise<string | null> {
    const row = await this.rows.findOneBy({ id: idOf(host, login) });
    if (!row) {
      return null;
    }
    if (row.status === 'broken') {
      throw this.authError(host);
    }
    if (row.expiresAt !== null && Date.parse(row.expiresAt) - this.clock.now() < REFRESH_AHEAD_MS) {
      return this.refresh(row);
    }
    return this.box.open(row.accessToken);
  }

  /** The numeric id and selection of the installation, for a repository added to a selected-repositories installation. */
  async installation(host: ProviderName, login: string): Promise<Installation | null> {
    const row = await this.rows.findOneBy({ id: idOf(host, login) });
    return row?.installationId ? { id: row.installationId, selection: row.selection ?? 'all' } : null;
  }

  /** The `owner/name` of the repositories of the installation the person's token can see. */
  async repositories(login: string): Promise<string[]> {
    const found = await this.installation('github', login);
    const token = found ? await this.tokenFor('github', login) : null;
    if (!found || !token) {
      return [];
    }
    const api = githubEndpoints(this.config.env).api;
    const body = await this.send(`${api}/user/installations/${found.id}/repositories?per_page=100`, token);
    const rows = (body as { repositories?: { full_name?: string }[] }).repositories ?? [];
    return rows.flatMap((row) => (row.full_name ? [row.full_name] : []));
  }

  /** Adds a new repository (`owner/name`) to the person's installation when it covers selected repositories only. */
  async addRepository(login: string, fullName: string): Promise<void> {
    const found = await this.installation('github', login);
    const token = found?.selection === 'selected' ? await this.tokenFor('github', login) : null;
    if (!found || !token) {
      return;
    }
    const api = githubEndpoints(this.config.env).api;
    const { id } = (await this.send(`${api}/repos/${fullName}`, token)) as { id?: number };
    const response = await request(
      this.clock,
      `${api}/user/installations/${found.id}/repositories/${id}`,
      this.headers(token),
      [],
      { method: 'PUT', body: '' },
    );
    if (!id || response.status >= 400) {
      throw new SwarmloopError(`github did not add ${fullName} to the installation: HTTP ${response.status}`);
    }
  }

  private refresh(row: ConnectionEntity): Promise<string> {
    const running = this.refreshing.get(row.id);
    if (running) {
      return running;
    }
    const started = this.refreshNow(row).finally(() => this.refreshing.delete(row.id));
    this.refreshing.set(row.id, started);
    return started;
  }

  private async refreshNow(row: ConnectionEntity): Promise<string> {
    const host = row.host as ProviderName;
    const app = this.apps.credentials(host);
    if (!app || !row.refreshToken) {
      return this.broken(row);
    }
    const endpoints = this.endpoints(host);
    const response = await request(this.clock, endpoints.token, JSON_HEADERS, [], {
      method: 'POST',
      body: JSON.stringify({
        client_id: app.clientId,
        client_secret: app.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: this.box.open(row.refreshToken),
      }),
    });
    const granted = parse(response.body) as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (response.status >= 500 || response.status === 429) {
      throw new SwarmloopError(`${host} could not refresh the token: HTTP ${response.status}`);
    }
    if (response.status >= 400 || !granted.access_token) {
      return this.broken(row);
    }
    const next = this.row(
      host,
      row.login,
      { accessToken: granted.access_token, refreshToken: granted.refresh_token ?? '', expiresIn: granted.expires_in },
      row.installationId ? { id: row.installationId, selection: row.selection ?? 'all' } : null,
    );
    await this.rows.save(next);
    return granted.access_token;
  }

  private async broken(row: ConnectionEntity): Promise<never> {
    await this.rows.update({ id: row.id }, { status: 'broken' });
    throw this.authError(row.host);
  }

  private authError(host: string): GitAuthError {
    return new GitAuthError(`Reconnect ${host === 'gitlab' ? 'GitLab' : 'GitHub'}`);
  }

  private row(host: ProviderName, login: string, grant: Grant, installation: Installation | null): ConnectionEntity {
    const now = this.clock.now();
    return {
      id: idOf(host, login),
      host,
      login,
      accessToken: this.box.seal(grant.accessToken),
      refreshToken: grant.refreshToken ? this.box.seal(grant.refreshToken) : '',
      expiresAt: grant.expiresIn ? new Date(now + grant.expiresIn * 1000).toISOString() : null,
      refreshedAt: new Date(now).toISOString(),
      status: 'ok',
      installationId: installation?.id ?? null,
      selection: installation?.selection ?? null,
    };
  }

  private healthOf(row: ConnectionEntity): ConnectionHealth {
    return {
      login: row.login,
      status: row.status,
      expiresAt: row.expiresAt,
      refreshedAt: row.refreshedAt,
      installationId: row.installationId,
      selection: row.selection,
    };
  }

  private endpoints(host: ProviderName): Endpoints {
    return host === 'github' ? githubEndpoints(this.config.env) : gitlabEndpoints(this.config.env);
  }

  /** The installation of this app among those the person's token can use. */
  private async installationOf(token: string): Promise<Installation | null> {
    const app = this.apps.find('github');
    const body = await this.send(`${githubEndpoints(this.config.env).api}/user/installations?per_page=100`, token);
    const rows = (body as { installations?: { id?: number; app_id?: number; repository_selection?: string }[] })
      .installations;
    const mine = (rows ?? []).find((row) => !app || String(row.app_id) === app.appId);
    return mine?.id ? { id: String(mine.id), selection: mine.repository_selection ?? 'all' } : null;
  }

  private headers(token: string): Record<string, string> {
    return { ...this.endpoints('github').userHeaders(token), 'Content-Type': 'application/json' };
  }

  private async send(url: string, token: string): Promise<unknown> {
    const response = await request(this.clock, url, this.headers(token), []);
    if (response.status >= 400) {
      throw new SwarmloopError(`github answered ${response.status}`);
    }
    return parse(response.body);
  }
}

const JSON_HEADERS = { Accept: 'application/json', 'Content-Type': 'application/json' };

function parse(body: Buffer): unknown {
  try {
    return JSON.parse(body.toString('utf8')) as unknown;
  } catch {
    return {};
  }
}
