import type { SwarmloopEnv } from '../../../config/env';
import type { Endpoints } from '../login-provider';

/** What the host calls the app of its login. */
export const GITLAB_APP_LABEL = 'Application';

export function gitlabEndpoints(env: Pick<SwarmloopEnv, 'GITLAB_BASE_URL'>): Endpoints {
  const base = new URL(env.GITLAB_BASE_URL || 'https://gitlab.com');
  const root = base.toString().replace(/\/$/, '');
  return {
    appLabel: GITLAB_APP_LABEL,
    installs: false,
    authorize: `${root}/oauth/authorize`,
    token: `${root}/oauth/token`,
    api: `${root}/api/v4`,
    scope: 'read_user api write_repository',
    userHeaders: (token) => ({ Authorization: `Bearer ${token}` }),
    user: { path: '/user', field: 'username' },
    groups: { path: '/groups?min_access_level=10&per_page=100', field: 'full_path' },
    repoPath: (ref) => `/projects/${encodeURIComponent(`${ref.owner}/${ref.name}`)}`,
    pushes: (row) => {
      const { project_access, group_access } = (row.permissions ?? {}) as Record<
        string,
        { access_level?: number } | null
      >;
      return Math.max(project_access?.access_level ?? 0, group_access?.access_level ?? 0) >= 30;
    },
  };
}
