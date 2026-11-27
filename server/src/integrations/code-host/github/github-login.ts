import type { SwarmloopEnv } from '../../../config/env';
import type { Endpoints } from '../login-provider';

/** What the host calls the app of its login. */
export const GITHUB_APP_LABEL = 'App';

export function githubEndpoints(env: Pick<SwarmloopEnv, 'GITHUB_BASE_URL'>): Endpoints {
  const base = new URL(env.GITHUB_BASE_URL || 'https://github.com');
  const hosted = base.hostname === 'github.com' || base.hostname === 'www.github.com';
  return {
    appLabel: GITHUB_APP_LABEL,
    installs: true,
    authorize: `${base.origin}/login/oauth/authorize`,
    token: `${base.origin}/login/oauth/access_token`,
    api: hosted ? 'https://api.github.com' : `${base.origin}/api/v3`,
    scope: 'read:user read:org',
    appCheck: { accepted: 'bad_verification_code', rejected: 'incorrect_client_credentials' },
    userHeaders: (token) => ({
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'swarmloop',
    }),
    user: { path: '/user', field: 'login' },
    groups: { path: '/user/orgs?per_page=100', field: 'login' },
    repoPath: (ref) => `/repos/${ref.owner}/${ref.name}`,
    pushes: (row) => (row.permissions as { push?: unknown } | undefined)?.push === true,
  };
}
