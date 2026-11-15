import type { CodeHostAdapter } from '../code-host-adapter';
import { HttpOAuthProvider } from '../http-login-provider';
import { GithubCodeHost } from './github-code-host';
import { githubConnection } from './github-connection';
import { GITHUB_APP_LABEL, githubEndpoints } from './github-login';
import { githubRules } from './github-rules';

export const adapter: CodeHostAdapter = {
  name: githubRules.name,
  label: githubRules.label,
  baseKey: 'GITHUB_BASE_URL',
  tokenKey: 'GITHUB_TOKEN',
  create: (env, clock) => new GithubCodeHost(env, clock),
  rules: githubRules,
  connection: githubConnection,
  pushOrder: 1,
  createsByDefault: true,
  // Composer downloads the archives of GitHub packages from these two.
  packageHosts: ['api.github.com', 'codeload.github.com'],
  // Packages with native code fetch a prebuilt binary from GitHub releases at install time (better-sqlite3, esbuild, sharp).
  setupDownloads: ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'],
  publicHost: 'github.com',
  appLabel: GITHUB_APP_LABEL,
  allowPrefixes: { user: 'github:', group: 'github-org:' },
  clientEnvKeys: { clientId: 'GITHUB_OAUTH_CLIENT_ID', clientSecret: 'GITHUB_OAUTH_CLIENT_SECRET' },
  keepsTokensWithoutApp: false,
  storesApplication: false,
  login: (env, clock, apps) => new HttpOAuthProvider(adapter, githubEndpoints(env), env[adapter.tokenKey], clock, apps),
  ownerFromActor: true,
};
