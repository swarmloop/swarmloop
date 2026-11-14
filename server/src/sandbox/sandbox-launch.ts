import { chmodSync, chownSync, existsSync, mkdirSync, readdirSync, realpathSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join, resolve, sep } from 'path';
import type { RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';
import { RUNTIME_NAMES, runtimeFor } from '../integrations/agent-runtime/agent-runtime.registry';
import { SwarmloopError } from '../core/swarmloop-error';
import { readDefaultSettings } from '../config/load-env';
import { rawEnv } from '../config/process-env';
import { EGRESS_API, isLeaseIp } from './egress';
import {
  hostName,
  hostRefusal,
  isLocalHost,
  matchesHost,
  MODEL_HOSTS,
  REGISTRIES,
  SETUP_DOWNLOADS,
  sandboxNetworkName,
} from './sandbox-hosts';
import { imageName } from './image-resolver';
import { assertDaemonPath, assertMask, assertMount, assertProject, sandboxMount } from './sandbox-checks';
import { CLI_ROOT, egressProxyArgs, projectImageArgs } from './sandbox-args';
import type { SandboxLaunch } from './sandbox-types';

import type { SandboxMount } from '../core/sandbox-mount';
export type { EnvMask, ManifestHosts, ProjectLaunch, SandboxLaunch } from './sandbox-types';
export { CLI_ROOT } from './sandbox-args';
const PROJECT_TMP = '/tmp:rw,exec,nosuid,nodev,size=1g,mode=1777';
/** Test runners and JVM builds start many threads, and every thread counts. Still a ceiling against a fork bomb. */
const PROJECT_PIDS = '1024';
/**
 * Agents run their commands in a login shell (`bash -lc`), and /etc/profile of Debian and Ubuntu images sets PATH
 * anew, which drops the CLI directory and its `rg`. The home profile runs after it and puts the sandbox PATH back.
 */
export const KEEP_PATH = `printf 'export PATH="%s"\\n' "$PATH" > "$HOME/.profile" && cp "$HOME/.profile" "$HOME/.bash_profile" && exec "$@"`;

const SANDBOX_PIDS = '256';

/** Below the default weight of 1024 that the server and the dashboard keep, so they win a fight for the CPU. */
const SANDBOX_CPU_SHARES = 512;

const MODEL_ENV = new Set(RUNTIME_NAMES.flatMap((name) => runtimeFor(name).credentialNames));
/** Settings a CLI behind the egress proxy may get on top of its placeholder key. */
const EGRESS_ENV: Record<string, (value: string) => boolean> = {
  ANTHROPIC_BASE_URL: (value) => value === EGRESS_API,
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: (value) => value === '1',
};

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

/** The agent image of a runtime. */
export function agentImage(runtime: RuntimeName): string {
  return imageName(runtimeFor(runtime).component);
}

/** Containers for one step, including fan-out names such as code-review-security. */
export function stepContainers(base: string, names: readonly string[]): string[] {
  return names.filter((name) => name === base || name.startsWith(`${base}-`));
}

/** The labels every run container carries, so a Stop finds it without guessing from its name. */
function runLabels(launch: Pick<SandboxLaunch, 'runKey' | 'step' | 'attemptId'>): string[] {
  return [
    '--label',
    `swarmloop.run=${launch.runKey}`,
    '--label',
    `swarmloop.step=${launch.step}`,
    '--label',
    `swarmloop.attempt=${launch.attemptId}`,
  ];
}

export function containerName(runKey: string, step: string): string {
  const name = `swarmloop-${runKey}-${step}`.toLowerCase();
  if (!/^[a-z0-9][a-z0-9_.-]+$/.test(name)) {
    throw new SwarmloopError('sandbox container name is invalid');
  }
  return name;
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

/** Writes files into a state directory so the sandbox user can read them. Paths are relative to it. */
export function writeHomeFiles(
  files: readonly { path: string; content: string; mode: number }[],
  statePath: string,
  userId: number,
): void {
  for (const file of files) {
    const path = join(statePath, file.path);
    prepareStateDir(dirname(path), userId);
    writeFileSync(path, file.content);
    chmodSync(path, file.mode);
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
  return Number(readDefaultSettings().SWARMLOOP_UID);
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
  const manifest = launch.manifestHosts;
  for (const host of manifest?.hosts ?? []) {
    const reason = hostRefusal(host, launch.project?.shell !== undefined ? 'setup' : 'agent', manifest?.origins ?? []);
    if (reason) {
      throw new SwarmloopError(`${host} ${reason}`);
    }
  }
  for (const host of launch.allowHosts) {
    const name = hostName(host);
    const known = REGISTRIES.has(name) || SETUP_DOWNLOADS.has(name) || (manifest?.hosts ?? []).includes(name);
    if (!isLocalHost(name) && !known && ![...MODEL_HOSTS].some((rule) => matchesHost(rule, name))) {
      throw new SwarmloopError(`${name} is a production host`);
    }
  }
  if (launch.egress && !isLeaseIp(launch.egress.ip)) {
    throw new SwarmloopError('sandbox address is not allowed');
  }
  for (const mount of launch.mounts) {
    assertMount(mount, home, launch.workRoots);
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
    ...runLabels(launch),
    '--user',
    `${launch.userId}:${launch.userId}`,
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--pids-limit',
    project ? PROJECT_PIDS : SANDBOX_PIDS,
    '--cpu-shares',
    String(SANDBOX_CPU_SHARES),
    '--read-only',
    '--tmpfs',
    project ? PROJECT_TMP : '/tmp:rw,nosuid,nodev,size=64m,mode=1777',
  );
  if (launch.memoryCapBytes !== undefined) {
    args.push('--memory', `${launch.memoryCapBytes}b`);
  }
  if (state) {
    args.push('--mount', `type=bind,src=${state},dst=/home/sandbox,readonly=false`);
  } else {
    args.push('--tmpfs', `/home/sandbox:rw,nosuid,nodev,size=64m,uid=${launch.userId},gid=${launch.userId},mode=700`);
  }
  projectImageArgs(args, launch);
  egressProxyArgs(args, launch, network);
  for (const item of launch.env ?? []) {
    const proxied = launch.egress !== undefined && EGRESS_ENV[item.name]?.(item.value) === true;
    if ((!MODEL_ENV.has(item.name) && !proxied) || item.value === '' || /[\r\n\0]/.test(item.value)) {
      throw new SwarmloopError('sandbox env is not allowed');
    }
    args.push('--env', `${item.name}=${item.value}`);
  }
  for (const name of launch.unsetEnv ?? []) {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) {
      throw new SwarmloopError('sandbox env is not allowed');
    }
    args.push('--env', `${name}=`);
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
  args.push('--workdir', workdir, agentImage(launch.runtime), ...launch.command);
  return args;
}
