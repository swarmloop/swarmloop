import type { CodeHostAdapter } from '../code-host-adapter';
import { GitlabCodeHost } from './gitlab-code-host';
import { gitlabConnection } from './gitlab-connection';
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
  ownerFromActor: false,
};
