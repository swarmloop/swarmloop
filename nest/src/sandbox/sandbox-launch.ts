import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync } from 'fs';
import { homedir } from 'os';
import { dirname, isAbsolute, join, resolve, sep } from 'path';
import { SwarmloopError } from '../swarmloop-error';

export interface SandboxMount {
  hostPath: string;
  containerPath: string;
  /** Path the Docker daemon bind-mounts. Equals hostPath when Nest runs on the host. */
  daemonPath?: string;
  /** Named volume shared by Nest and the sandbox. Mutually exclusive with daemonPath. */
  volume?: string;
  readonly?: boolean;
}

export interface EnvMask {
  hostFile: string;
  containerFile: string;
}

export interface SandboxLaunch {
  runtime: 'cursor' | 'claude';
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
  /** Attach the caller's stdin. */
  stdin?: boolean;
  /** Allocate a terminal. Only the interactive vendor screen needs one. */
  tty?: boolean;
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
]);

const MODEL_HOSTS = new Set(['api2.cursor.sh', 'api.cursor.com', 'cursor.com', 'api.anthropic.com']);
const MODEL_ENV = new Set(['CURSOR_API_KEY', 'ANTHROPIC_API_KEY']);

export function packageRegistries(): string[] {
  return [...REGISTRIES];
}

export function modelApiHosts(runtime: 'cursor' | 'claude'): string[] {
  return runtime === 'claude' ? ['api.anthropic.com'] : ['api2.cursor.sh', 'api.cursor.com', 'cursor.com'];
}

export function modelCredential(runtime: 'cursor' | 'claude', cursorKey: string, anthropicKey: string): { name: string; value: string } {
  if (runtime === 'claude') {
    if (anthropicKey === '') {
      throw new SwarmloopError('ANTHROPIC_API_KEY is missing');
    }
    return { name: 'ANTHROPIC_API_KEY', value: anthropicKey };
  }
  if (cursorKey === '') {
    throw new SwarmloopError('CURSOR_API_KEY is missing');
  }
  return { name: 'CURSOR_API_KEY', value: cursorKey };
}

export function imageName(runtime: 'cursor' | 'claude'): string {
  return `swarmloop-agent-${runtime}`;
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

/** Path the Docker daemon can bind. Nest may see the same directory through a different mount. */
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

/** The empty file that covers a checkout .env. It lives in data/, which Compose bind-mounts, so the daemon can see it when Nest itself is in a container. */
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
  configured = process.env.SWARMLOOP_UID,
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

export function sandboxArgs(launch: SandboxLaunch, home = homedir()): string[] {
  if (launch.userId <= 0) {
    throw new SwarmloopError('sandbox user is root');
  }
  if (launch.mounts.length === 0) {
    throw new SwarmloopError('sandbox mount is missing');
  }
  for (const host of launch.allowHosts) {
    const name = hostName(host);
    if (!isLocalHost(name) && !REGISTRIES.has(name) && !MODEL_HOSTS.has(name)) {
      throw new SwarmloopError(`${name} is a production host`);
    }
  }
  for (const mount of launch.mounts) {
    assertMount(mount, home);
  }
  const state = launch.stateDaemonPath ?? launch.statePath;
  if (state) {
    assertDaemonPath(state, home);
  }
  const network = sandboxNetworkName(launch.allowHosts);
  const args = ['run', '--rm'];
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
    '256',
    '--read-only',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=64m,mode=1777',
  );
  if (state) {
    args.push('--mount', `type=bind,src=${state},dst=/home/sandbox,readonly=false`);
  } else {
    args.push('--tmpfs', `/home/sandbox:rw,nosuid,nodev,size=64m,uid=${launch.userId},gid=${launch.userId},mode=700`);
  }
  if (network === null) {
    args.push('--network', 'none');
  } else {
    args.push('--network', network);
    if (network === 'swarmloop-local') {
      args.push('--add-host', 'host.docker.internal:host-gateway');
    }
  }
  for (const item of launch.env ?? []) {
    if (!MODEL_ENV.has(item.name) || item.value === '' || /[\r\n\0]/.test(item.value)) {
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
  args.push('--workdir', launch.mounts[0]?.containerPath ?? '/work', imageName(launch.runtime), ...launch.command);
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

function assertDaemonPath(path: string, home: string): void {
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

function assertMask(mask: EnvMask, mounts: SandboxMount[]): void {
  const fits = mounts.some((mount) => mask.containerFile.startsWith(`${mount.containerPath}/`));
  if (!fits || mask.containerFile.includes('..')) {
    throw new SwarmloopError('sandbox mount is not allowed');
  }
}
