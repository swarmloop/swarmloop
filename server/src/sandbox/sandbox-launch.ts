import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve, sep } from 'path';
import type { RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';
import { RUNTIME_NAMES, runtimeFor } from '../integrations/agent-runtime/agent-runtime.registry';
import { SwarmloopError } from '../core/swarmloop-error';
import { rawEnv } from '../config/process-env';
import { EGRESS_API, EGRESS_IP, EGRESS_NETWORK, egressEnv, isLeaseIp } from './egress';

export interface SandboxMount {
  hostPath: string;
  containerPath: string;
  /** Path the Docker daemon bind-mounts. Equals hostPath when the server runs on the host. */
  daemonPath?: string;
  /** Named volume shared by the server and the sandbox. Mutually exclusive with daemonPath. */
  volume?: string;
  readonly?: boolean;
}

export interface EnvMask {
  hostFile: string;
  containerFile: string;
}

export interface SandboxLaunch {
  runtime: RuntimeName;
  runKey: string;
  step: string;
  mounts: SandboxMount[];
  envMasks: EnvMask[];
  allowHosts: string[];
  command: string[];
  userId: number;
  maskFile: string;
  /** Only the runtime model key. Other tokens stay out of the container. */
  env?: { name: string; value: string }[];
  /** Durable home for the vendor session. Replaces the /home/sandbox tmpfs. */
  statePath?: string;
  stateDaemonPath?: string;
  /** Run in the project's own image, with the agent CLI mounted read-only from a volume. */
  project?: ProjectLaunch;
  /** The address on the internal sandbox network. Its policy on the egress proxy decides what it reaches. */
  egress?: { ip: string };
  /** Attach the caller's stdin. */
  stdin?: boolean;
  /** Allocate a terminal. Only the interactive vendor screen needs one. */
  tty?: boolean;
}

export interface ProjectLaunch {
  image: string;
  /** The volume that holds the agent image's /opt/swarmloop. */
  cliVolume: string;
  /** PATH of the project image. The CLI directory goes in front of it. */
  path: string;
  /** The image has no CA bundle of its own, so OpenSSL tools use the one from the CLI volume. */
  certFile: boolean;
  /** Package-manager caches below /home/sandbox, kept between runs. */
  caches: { daemonPath: string; containerPath: string }[];
  /** A shell command to run instead of the agent CLI, for the setup of the environment. */
  shell?: string;
}

export const CLI_ROOT = '/opt/swarmloop';
const CLI_CERTS = `${CLI_ROOT}/certs/ca-certificates.crt`;
const PROJECT_TMP = '/tmp:rw,exec,nosuid,nodev,size=1g,mode=1777';
/** Test runners and JVM builds start many threads, and every thread counts. Still a ceiling against a fork bomb. */
const PROJECT_PIDS = '1024';
const AGENT_COMMANDS = new Set(['agent', 'claude', 'codex']);
/**
 * Agents run their commands in a login shell (`bash -lc`), and /etc/profile of Debian and Ubuntu images sets PATH
 * anew, which drops the CLI directory and its `rg`. The home profile runs after it and puts the sandbox PATH back.
 */
export const KEEP_PATH = `printf 'export PATH="%s"\\n' "$PATH" > "$HOME/.profile" && cp "$HOME/.profile" "$HOME/.bash_profile" && exec "$@"`;

function assertProject(project: ProjectLaunch, command: string[], home: string): void {
  const valid =
    /^[A-Za-z0-9][A-Za-z0-9_./:@-]{0,254}$/.test(project.image) &&
    /^swarmloop-cli-[a-z]+-[0-9a-f]{12}$/.test(project.cliVolume) &&
    /^[A-Za-z0-9_./:-]+$/.test(project.path) &&
    (project.shell === undefined ? AGENT_COMMANDS.has(command[0] ?? '') : command.length === 0 && project.shell !== '');
  if (!valid) {
    throw new SwarmloopError('sandbox project image is not allowed');
  }
  for (const cache of project.caches) {
    const path = cache.containerPath;
    if (!path.startsWith('/home/sandbox/') || path.split('/').includes('..') || path.endsWith('/')) {
      throw new SwarmloopError(`cache path ${path} is not allowed`);
    }
    assertDaemonPath(cache.daemonPath, home);
  }
}

const WORKTREE = /^\/work(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,63})?$/;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', 'host.docker.internal']);
const REGISTRIES = new Set([
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
export const SANDBOX_PIDS = '256';

const MODEL_HOSTS = new Set(RUNTIME_NAMES.flatMap((name) => runtimeFor(name).apiHosts));
const MODEL_ENV = new Set(RUNTIME_NAMES.flatMap((name) => runtimeFor(name).credentialNames));
/** Settings a CLI behind the egress proxy may get on top of its placeholder key. */
const EGRESS_ENV: Record<string, (value: string) => boolean> = {
  ANTHROPIC_BASE_URL: (value) => value === EGRESS_API,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: (value) => value === '1',
};

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

export function packageRegistries(): string[] {
  return [...REGISTRIES];
}

export function modelApiHosts(runtime: RuntimeName): string[] {
  return [...runtimeFor(runtime).apiHosts];
}

export function modelCredential(
  runtime: RuntimeName,
  cursorKey: string,
  anthropicKey: string,
  oauthToken: string,
  codexAuth = '',
  codexApiKey = '',
): { name: string; value: string } {
  return runtimeFor(runtime).credential({ cursorKey, anthropicKey, oauthToken, codexAuth, codexApiKey });
}

export function imageName(runtime: RuntimeName): string {
  return runtimeFor(runtime).image;
}

/** Containers for one step, including fan-out names such as code-review-security. */
export function stepContainers(base: string, names: readonly string[]): string[] {
  return names.filter((name) => name === base || name.startsWith(`${base}-`));
}

export function containerName(runKey: string, step: string): string {
  const name = `swarmloop-${runKey}-${step}`.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]+$/.test(name)) {
    throw new SwarmloopError('sandbox container name is invalid');
  }
  return name;
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

export function mountsForRun(worktreesDir: string, targetPath: string | null): SandboxMount[] {
  if (targetPath) {
    return [{ hostPath: targetPath, containerPath: '/work' }];
  }
  const names = readdirSync(worktreesDir)
    .filter((name) => !name.startsWith('.') && statSync(join(worktreesDir, name)).isDirectory())
    .sort();
  if (names.length === 0) {
    return [{ hostPath: worktreesDir, containerPath: '/work' }];
  }
  return names.map((name) => ({ hostPath: join(worktreesDir, name), containerPath: `/work/${name}` }));
}

export interface BindMount {
  destination: string;
  source: string;
}

/** Path the Docker daemon can bind. The server may see the same directory through a different mount. */
export function resolveDaemonPath(containerPath: string, binds: BindMount[]): string {
  const real = existsSync(containerPath) ? realpathSync(containerPath) : resolve(containerPath);
  const hit = binds
    .filter((bind) => covers(bind.destination, real))
    .sort((left, right) => right.destination.length - left.destination.length)[0];
  if (!hit) {
    return real;
  }
  return `${hit.source}${real.slice(hit.destination.length)}`;
}

function covers(destination: string, real: string): boolean {
  return destination !== '/' && (real === destination || real.startsWith(`${destination}/`));
}

const STATE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function agentStateDir(root: string, key: string, step?: string): string {
  if (!STATE_NAME.test(key)) {
    throw new SwarmloopError('sandbox container name is invalid');
  }
  const base = join(root, 'data', 'agent-state', key);
  if (!step) {
    return base;
  }
  if (!STATE_NAME.test(step)) {
    throw new SwarmloopError('sandbox step is invalid');
  }
  return join(base, step);
}

/** The empty file that covers a checkout .env. It lives in data/, which Compose bind-mounts, so the daemon can see it when the server itself is in a container. */
export function emptyEnvFile(statePath: string): string {
  const parts = statePath.split(sep);
  const at = parts.lastIndexOf('agent-state');
  const data = at > 0 ? parts.slice(0, at).join(sep) : dirname(dirname(statePath));
  return join(data, 'swarmloop-empty-env');
}

/** The sandbox user must be able to write the session directory. */
export function prepareStateDir(path: string, userId: number): void {
  mkdirSync(path, { recursive: true });
  try {
    chownSync(path, userId, userId);
    chmodSync(path, 0o700);
  } catch {
    chmodSync(path, 0o777);
  }
}

export function sandboxUserId(
  own = typeof process.getuid === 'function' ? (process.getuid() ?? 0) : 0,
  configured = rawEnv().SWARMLOOP_UID,
): number {
  if (own > 0) {
    return own;
  }
  const parsed = Number(configured);
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }
  return 1000;
}

/** A Docker runtime such as `runsc` (gVisor), which gives each sandbox its own kernel. Empty is Docker's default. */
export function sandboxEngine(value = rawEnv().SANDBOX_DOCKER_RUNTIME): string {
  const engine = (value ?? '').trim();
  if (engine !== '' && !/^[a-z][a-z0-9_.-]{0,63}$/.test(engine)) {
    throw new SwarmloopError('SANDBOX_DOCKER_RUNTIME is not a runtime name');
  }
  return engine;
}

export function sandboxArgs(launch: SandboxLaunch, home = homedir(), engine = sandboxEngine()): string[] {
  if (launch.userId <= 0) {
    throw new SwarmloopError('sandbox user is root');
  }
  if (launch.mounts.length === 0) {
    throw new SwarmloopError('sandbox mount is missing');
  }
  for (const host of launch.allowHosts) {
    const name = hostName(host);
    if (!isLocalHost(name) && !REGISTRIES.has(name) && ![...MODEL_HOSTS].some((rule) => matchesHost(rule, name))) {
      throw new SwarmloopError(`${name} is a production host`);
    }
  }
  if (launch.egress && !isLeaseIp(launch.egress.ip)) {
    throw new SwarmloopError('sandbox address is not allowed');
  }
  for (const mount of launch.mounts) {
    assertMount(mount, home);
  }
  const state = launch.stateDaemonPath ?? launch.statePath;
  if (state) {
    assertDaemonPath(state, home);
  }
  const project = launch.project;
  if (project) {
    assertProject(project, launch.command, home);
  }
  const network = sandboxNetworkName(launch.allowHosts);
  const args = ['run', '--rm'];
  const runtime = sandboxEngine(engine);
  if (runtime !== '') {
    args.push('--runtime', runtime);
  }
  if (launch.tty) {
    args.push('-t');
  }
  if (launch.stdin) {
    args.push('-i');
  }
  args.push(
    '--name',
    containerName(launch.runKey, launch.step),
    '--user',
    `${launch.userId}:${launch.userId}`,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    project ? PROJECT_PIDS : SANDBOX_PIDS,
    '--read-only',
    '--tmpfs',
    project ? PROJECT_TMP : '/tmp:rw,nosuid,nodev,size=64m,mode=1777',
  );
  if (state) {
    args.push('--mount', `type=bind,src=${state},dst=/home/sandbox,readonly=false`);
  } else {
    args.push('--tmpfs', `/home/sandbox:rw,nosuid,nodev,size=64m,uid=${launch.userId},gid=${launch.userId},mode=700`);
  }
  if (project) {
    for (const cache of project.caches) {
      args.push('--mount', `type=bind,src=${cache.daemonPath},dst=${cache.containerPath},readonly=false`);
    }
    args.push('--mount', `type=volume,src=${project.cliVolume},dst=${CLI_ROOT},readonly=true`);
    args.push('--env', 'HOME=/home/sandbox', '--env', `PATH=${CLI_ROOT}/bin:${project.path}`);
    args.push('--env', `NODE_EXTRA_CA_CERTS=${CLI_CERTS}`);
    if (project.certFile) {
      args.push('--env', `SSL_CERT_FILE=${CLI_CERTS}`);
    }
  }
  if (launch.egress) {
    // Names are resolved by the proxy. Docker before 25.0.5 forwards DNS from internal networks (CVE-2024-29018),
    // so the resolver is the proxy's address, where nothing answers on port 53: a lookup fails at once on any engine.
    args.push('--network', EGRESS_NETWORK, '--ip', launch.egress.ip, '--dns', EGRESS_IP);
    for (const item of egressEnv()) {
      args.push('--env', `${item.name}=${item.value}`);
    }
  } else if (network === null) {
    args.push('--network', 'none');
  } else {
    args.push('--network', network);
    if (network === 'swarmloop-local') {
      args.push('--add-host', 'host.docker.internal:host-gateway');
    }
  }
  for (const item of launch.env ?? []) {
    const proxied = launch.egress !== undefined && EGRESS_ENV[item.name]?.(item.value) === true;
    if ((!MODEL_ENV.has(item.name) && !proxied) || item.value === '' || /[\r\n\0]/.test(item.value)) {
      throw new SwarmloopError('sandbox env is not allowed');
    }
    args.push('--env', `${item.name}=${item.value}`);
  }
  for (const mount of launch.mounts) {
    args.push('--mount', sandboxMount(mount));
  }
  for (const mask of launch.envMasks) {
    assertMask(mask, launch.mounts);
    args.push('--mount', `type=bind,src=${launch.maskFile},dst=${mask.containerFile},readonly=true`);
  }
  const workdir = launch.mounts[0]?.containerPath ?? '/work';
  if (project?.shell !== undefined) {
    args.push('--workdir', workdir, '--entrypoint', 'sh', project.image, '-c', project.shell);
    return args;
  }
  if (project) {
    const [command, ...rest] = launch.command;
    args.push('--workdir', workdir, '--entrypoint', 'sh', project.image, '-c', KEEP_PATH, 'sh');
    args.push(`${CLI_ROOT}/bin/${command ?? ''}`, ...rest);
    return args;
  }
  args.push('--workdir', workdir, imageName(launch.runtime), ...launch.command);
  return args;
}

export function sandboxMount(mount: SandboxMount): string {
  const access = mount.readonly ? 'true' : 'false';
  if (mount.volume) {
    if (mount.daemonPath !== undefined || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(mount.volume)) {
      throw new SwarmloopError('sandbox mount is not allowed');
    }
    return `type=volume,src=${mount.volume},dst=${mount.containerPath},readonly=${access}`;
  }
  return `type=bind,src=${mount.daemonPath ?? mount.hostPath},dst=${mount.containerPath},readonly=${access}`;
}

function assertMount(mount: SandboxMount, home: string): void {
  if (!WORKTREE.test(mount.containerPath)) {
    throw new SwarmloopError('sandbox mount is not allowed');
  }
  assertDaemonPath(mount.hostPath, home);
  if (mount.daemonPath !== undefined) {
    assertDaemonPath(mount.daemonPath, home);
  }
  sandboxMount(mount);
}

export function assertDaemonPath(path: string, home: string): void {
  if (!isAbsolute(path)) {
    throw new SwarmloopError('sandbox mount is not allowed');
  }
  const host = resolve(path);
  const root = resolve(home);
  const ssh = resolve(home, '.ssh');
  if (host === root || host === ssh || host.startsWith(`${ssh}${sep}`) || root.startsWith(`${host}${sep}`)) {
    throw new SwarmloopError('sandbox mount is not allowed');
  }
  if (host.endsWith(`${sep}docker.sock`) || host.endsWith(`${sep}.env`)) {
    throw new SwarmloopError('sandbox mount is not allowed');
  }
}

export function assertMask(mask: EnvMask, mounts: SandboxMount[]): void {
  const fits = mounts.some((mount) => mask.containerFile.startsWith(`${mount.containerPath}/`));
  if (!fits || mask.containerFile.includes('..')) {
    throw new SwarmloopError('sandbox mount is not allowed');
  }
}
