import { createSign } from 'crypto';
import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { SwarmloopError } from '../core/swarmloop-error';
import { request } from '../integrations/http';
import { HostAppsService } from './host-apps.service';
import { githubEndpoints } from './oauth-provider';

/** The longest name GitHub accepts for an app. */
const NAME_LIMIT = 34;

const GITHUB_HEADERS = { Accept: 'application/vnd.github+json', 'User-Agent': 'swarmloop' };

const PERMISSIONS = {
  contents: 'write',
  pull_requests: 'write',
  workflows: 'write',
  administration: 'write',
  checks: 'read',
  actions: 'write',
  statuses: 'read',
  metadata: 'read',
};

export interface ManifestForm {
  /** Where the browser posts the manifest. */
  action: string;
  manifest: Record<string, unknown>;
}

/** The GitHub App made from a manifest: the form GitHub takes, and the exchange of its redirect. */
@Injectable()
export class GithubAppService {
  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
    private readonly apps: HostAppsService,
  ) {}

  /** The manifest and the GitHub page it goes to: the organization's page when the owner is one, else the account's. */
  async manifest(owner: string | undefined, state: string): Promise<ManifestForm> {
    const publicUrl = new URL(this.config.env.SWARMLOOP_PUBLIC_URL);
    const base = publicUrl.origin;
    const origin = this.origin();
    const path = (await this.isOrganization(owner))
      ? `/organizations/${encodeURIComponent(owner as string)}/settings/apps/new`
      : '/settings/apps/new';
    return {
      action: `${origin}${path}?state=${encodeURIComponent(state)}`,
      manifest: {
        name: `swarmloop-${publicUrl.hostname}`.slice(0, NAME_LIMIT),
        url: base,
        redirect_url: `${base}/auth/github/created`,
        callback_urls: [`${base}/auth/github/callback`],
        request_oauth_on_install: true,
        public: false,
        // No webhook: swarmloop polls GitHub, and GitHub refuses a hook URL it cannot reach (a loopback address).
        default_events: [],
        default_permissions: PERMISSIONS,
      },
    };
  }

  /** Trades the code GitHub redirected with for the app, and stores it encrypted. Returns the slug, which is not secret. */
  async convert(code: string, madeBy: string): Promise<string> {
    const url = `${githubEndpoints(this.config.env).api}/app-manifests/${encodeURIComponent(code)}/conversions`;
    const response = await request(this.clock, url, GITHUB_HEADERS, [], {
      method: 'POST',
      body: '',
    });
    const made = JSON.parse(response.body.toString('utf8')) as {
      id?: number;
      slug?: string;
      client_id?: string;
      client_secret?: string;
      pem?: string;
    };
    if (response.status >= 400 || !made.id || !made.slug || !made.client_id || !made.client_secret || !made.pem) {
      throw new SwarmloopError(`github did not make the app: HTTP ${response.status}`);
    }
    await this.apps.save({
      host: 'github',
      appId: String(made.id),
      slug: made.slug,
      clientId: made.client_id,
      clientSecret: made.client_secret,
      privateKey: made.pem,
      madeBy,
    });
    return made.slug;
  }

  /** The page where the person installs the app on the repositories they choose. */
  installUrl(slug: string, state: string): string {
    return `${this.origin()}/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`;
  }

  /** The login of the account an installation of the stored app belongs to, read as the app. Null when it cannot be read. */
  async installedAccount(installationId: string): Promise<string | null> {
    const app = this.apps.find('github');
    if (!app?.privateKey) {
      return null;
    }
    try {
      const url = `${githubEndpoints(this.config.env).api}/app/installations/${encodeURIComponent(installationId)}`;
      const response = await request(
        this.clock,
        url,
        { ...GITHUB_HEADERS, Authorization: `Bearer ${this.appJwt(app)}` },
        [],
      );
      const body = JSON.parse(response.body.toString('utf8')) as { account?: { login?: string } };
      return response.status < 400 ? (body.account?.login ?? null) : null;
    } catch {
      return null;
    }
  }

  private async isOrganization(owner: string | undefined): Promise<boolean> {
    if (!owner) {
      return false;
    }
    try {
      const response = await request(
        this.clock,
        `${githubEndpoints(this.config.env).api}/users/${encodeURIComponent(owner)}`,
        GITHUB_HEADERS,
        [],
      );
      return (
        response.status < 400 &&
        (JSON.parse(response.body.toString('utf8')) as { type?: string }).type === 'Organization'
      );
    } catch {
      return false;
    }
  }

  /** A short RS256 token that names the app, which is how GitHub asks for the app's own reads. */
  private appJwt(app: { appId: string; privateKey: string }): string {
    const now = Math.floor(this.clock.now() / 1000);
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: now - 60, exp: now + 9 * 60, iss: app.appId })}`;
    return `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(app.privateKey, 'base64url')}`;
  }

  private origin(): string {
    return new URL(this.config.env.GITHUB_BASE_URL || 'https://github.com').origin;
  }
}
