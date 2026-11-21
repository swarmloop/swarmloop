import type { CodeHostAdapter } from '../code-host-adapter';
import { HttpOAuthProvider } from '../http-login-provider';
import { GitlabCodeHost } from './gitlab-code-host';
import { gitlabConnection } from './gitlab-connection';
import { GITLAB_APP_LABEL, gitlabEndpoints, gitlabTokenPage } from './gitlab-login';
import { gitlabRules } from './gitlab-rules';

export const adapter: CodeHostAdapter = {
  name: gitlabRules.name,
  label: gitlabRules.label,
  baseKey: 'GITLAB_BASE_URL',
  tokenKey: 'GITLAB_TOKEN',
  tokenPrefixes: ['glpat-'],
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
  signsInWithToken: true,
  tokenPage: gitlabTokenPage,
  endpoints: gitlabEndpoints,
  login: (env, clock, apps, appFlow) =>
    new HttpOAuthProvider(adapter, adapter.endpoints(env), env[adapter.tokenKey], clock, apps, appFlow),
  ownerFromActor: false,
};
