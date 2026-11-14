import { isIP } from 'net';
import { rawEnv } from '../config/process-env';
import { RUNTIME_NAMES, runtimeFor } from '../integrations/agent-runtime/agent-runtime.registry';

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal']);
export const REGISTRIES = new Set([
  'registry.npmjs.org',
  'registry.yarnpkg.com',
  'pypi.org',
  'files.pythonhosted.org',
  'proxy.golang.org',
  'rubygems.org',
  'crates.io',
  'index.crates.io',
  'repo.maven.apache.org',
  'repo1.maven.org',
  'repo.packagist.org',
  'packagist.org',
  // Composer downloads the archives of GitHub packages from these two.
  'api.github.com',
  'codeload.github.com',
  'sum.golang.org',
  'static.crates.io',
  'index.rubygems.org',
  'repo.yarnpkg.com',
  'plugins.gradle.org',
  'services.gradle.org',
  'downloads.gradle.org',
]);
/** The API hosts of every runtime, and the hosts its CLI sign-in needs. */
export const MODEL_HOSTS = new Set(
  RUNTIME_NAMES.flatMap((name) => [
    ...runtimeFor(name).apiHosts,
    ...(runtimeFor(name).connection?.signIn?.().hosts ?? []),
  ]),
);

/** A rule is a host name, or `*.domain` for that domain and every name below it. */
export function matchesHost(rule: string, name: string): boolean {
  if (rule === name) {
    return true;
  }
  if (!rule.startsWith('*.')) {
    return false;
  }
  const domain = rule.slice(2);
  return name === domain || name.endsWith(`.${domain}`);
}

/**
 * Packages with native code fetch a prebuilt binary from GitHub releases at install time (better-sqlite3, esbuild,
 * sharp), and node-gyp falls back to the headers from nodejs.org. Only the setup gets these: github.com also takes
 * pushes, so the agent, which holds the model key and writes the code, does not.
 */
export const SETUP_DOWNLOADS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
  'nodejs.org',
]);

/** Hosts of the one-time environment setup: the registries, the release downloads of native packages, and the manifest's own. */
export function setupHosts(extra: readonly string[] = []): string[] {
  return [...new Set([...REGISTRIES, ...SETUP_DOWNLOADS, ...extra])];
}

export function packageRegistries(extra: readonly string[] = []): string[] {
  return [...new Set([...REGISTRIES, ...extra])];
}

/** The host of a URL, or of a git remote in ssh form (`git@host:path`). Empty when there is none. */
export function remoteHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return /^[^@/\s]+@([^:/\s]+):/.exec(url)?.[1]?.toLowerCase() ?? '';
  }
}

const HOST_NAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/**
 * The ceiling of the hosts a project manifest may name, for the setup or for the agent. Null when the host is allowed,
 * else the reason. The manifest reader and `sandboxArgs` both ask it, so a host the reader refuses never launches.
 * `origins` are the hosts of the checkout's remotes.
 */
export function hostRefusal(host: string, kind: 'setup' | 'agent', origins: readonly string[]): string | null {
  const env = rawEnv();
  if (isIP(host) !== 0 || isLocalHost(host)) {
    return 'is a local address';
  }
  if (!HOST_NAME.test(host)) {
    return 'is not a host name';
  }
  if ([...MODEL_HOSTS].some((rule) => matchesHost(rule, host))) {
    return 'is a model API host';
  }
  const trusted = [env.GITHUB_BASE_URL, env.GITLAB_BASE_URL, env.JIRA_BASE_URL].map((url) => remoteHost(url ?? ''));
  if (['github.com', 'gitlab.com', ...trusted, ...origins].includes(host)) {
    return 'is a code host';
  }
  if (kind === 'agent' && SETUP_DOWNLOADS.has(host)) {
    return 'is setup-only';
  }
  const allowed = (env.PROJECT_HOSTS_ALLOW ?? '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '');
  return allowed.length > 0 && !allowed.includes(host) ? 'is not in PROJECT_HOSTS_ALLOW' : null;
}

export function hostName(entry: string): string {
  if (entry.startsWith('[')) {
    const end = entry.indexOf(']');
    return end === -1 ? entry : entry.slice(1, end);
  }
  const colon = entry.lastIndexOf(':');
  if (colon > 0 && /^\d+$/.test(entry.slice(colon + 1))) {
    return entry.slice(0, colon);
  }
  return entry;
}

export function isLocalHost(host: string): boolean {
  return LOCAL_HOSTS.has(host) || host.endsWith('.local');
}

export function sandboxNetworkName(allowHosts: string[]): string | null {
  if (allowHosts.length === 0) {
    return null;
  }
  return allowHosts.every((entry) => isLocalHost(hostName(entry))) ? 'swarmloop-local' : 'swarmloop-registry';
}
