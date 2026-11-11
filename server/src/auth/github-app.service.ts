import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { SwarmloopError } from '../core/swarmloop-error';
import { request } from '../integrations/http';
import { HostAppsService } from './host-apps.service';
import { githubEndpoints } from './oauth-provider';

/** The longest name GitHub accepts for an app. */
const NAME_LIMIT = 34;

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

  /** The manifest and the GitHub page it goes to, for the account or for an organization. */
  manifest(org: string | undefined, state: string): ManifestForm {
    const publicUrl = new URL(this.config.env.SWARMLOOP_PUBLIC_URL);
    const base = publicUrl.origin;
    const origin = this.origin();
    const path = org ? `/organizations/${encodeURIComponent(org)}/settings/apps/new` : '/settings/apps/new';
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
  async convert(code: string): Promise<string> {
    const url = `${githubEndpoints(this.config.env).api}/app-manifests/${encodeURIComponent(code)}/conversions`;
    const response = await request(
      this.clock,
      url,
      { Accept: 'application/vnd.github+json', 'User-Agent': 'swarmloop' },
      [],
      {
        method: 'POST',
        body: '',
      },
    );
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
    });
    return made.slug;
  }

  /** The page where the person installs the app on the repositories they choose. */
  installUrl(slug: string, state: string): string {
    return `${this.origin()}/apps/${encodeURIComponent(slug)}/installations/new?state=${encodeURIComponent(state)}`;
  }

  private origin(): string {
    return new URL(this.config.env.GITHUB_BASE_URL || 'https://github.com').origin;
  }
}
