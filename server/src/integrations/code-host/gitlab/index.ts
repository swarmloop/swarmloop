import type { CodeHostAdapter } from '../code-host-adapter';
import { HttpOAuthProvider } from '../http-login-provider';
import { GitlabCodeHost } from './gitlab-code-host';
import { gitlabConnection } from './gitlab-connection';
import { GITLAB_APP_LABEL, gitlabEndpoints } from './gitlab-login';
import { gitlabRules } from './gitlab-rules';

export const adapter: CodeHostAdapter = {
  name: gitlabRules.name,
  label: gitlabRules.label,
  baseKey: 'GITLAB_BASE_URL',
  tokenKey: 'GITLAB_TOKEN',
  create: (env, clock) => new GitlabCodeHost(env, clock),
  rules: gitlabRules,
  connection: gitlabConnection,
  pushOrder: 0,
  createsByDefault: false,
  packageHosts: [],
  setupDownloads: [],
  publicHost: 'gitlab.com',
  appLabel: GITLAB_APP_LABEL,
  allowPrefixes: { user: 'gitlab:', group: 'gitlab-group:' },
  clientEnvKeys: { clientId: 'GITLAB_OAUTH_CLIENT_ID', clientSecret: 'GITLAB_OAUTH_CLIENT_SECRET' },
  keepsTokensWithoutApp: true,
  storesApplication: true,
  login: (env, clock, apps) => new HttpOAuthProvider(adapter, gitlabEndpoints(env), env[adapter.tokenKey], clock, apps),
  ownerFromActor: false,
};
