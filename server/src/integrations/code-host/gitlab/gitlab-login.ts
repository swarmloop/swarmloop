import type { SwarmloopEnv } from '../../../config/env';
import type { Endpoints } from '../login-provider';

/** What the host calls the app of its login. */
export const GITLAB_APP_LABEL = 'Application';

type GitlabBase = Pick<SwarmloopEnv, 'GITLAB_BASE_URL'>;

const rootOf = (env: GitlabBase): string =>
  new URL(env.GITLAB_BASE_URL || 'https://gitlab.com').toString().replace(/\/$/, '');

/** The page where a person makes a personal access token with the name and scopes swarmloop needs. */
export const gitlabTokenPage = (env: GitlabBase): string =>
  `${rootOf(env)}/-/user_settings/personal_access_tokens?name=swarmloop&scopes=read_user,api,write_repository`;

export function gitlabEndpoints(env: GitlabBase): Endpoints {
  const root = rootOf(env);
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
