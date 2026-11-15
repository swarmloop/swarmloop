/** The env keys of the code hosts' base urls and server tokens. */
export const CODE_HOST_ENV_KEYS = ['GITLAB_BASE_URL', 'GITLAB_TOKEN', 'GITHUB_BASE_URL', 'GITHUB_TOKEN'] as const;

/** The env keys of the code hosts' login applications. */
export const CODE_HOST_LOGIN_ENV_KEYS = [
  'GITHUB_OAUTH_CLIENT_ID',
  'GITHUB_OAUTH_CLIENT_SECRET',
  'GITLAB_OAUTH_CLIENT_ID',
  'GITLAB_OAUTH_CLIENT_SECRET',
] as const;
