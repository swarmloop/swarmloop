import { spawn, ChildProcess, execFile } from 'child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { AppConfig, splitList } from '../config/env';
import { rawEnv } from '../config/process-env';
import { resolveRepoRoot } from '../config/repo-root';
import { SystemClock } from '../core/clock';
import { RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';
import { barrier } from '../core/barrier';
import { ERROR_CODES } from '../contract/error-codes';
import { SwarmloopError } from '../core/swarmloop-error';
import type { SandboxMount } from '../core/sandbox-mount';
import {
  BindMount,
  emptyEnvFile,
  EnvMask,
  agentImage,
  prepareStateDir,
  SandboxLaunch,
  resolveDaemonPath,
  sandboxArgs,
  sandboxUserId,
} from '../sandbox/sandbox-launch';
import { hostName, isLocalHost, sandboxNetworkName } from './sandbox-hosts';
import { attemptRunning, killAttempt, stopRun } from './run-containers';
import type { DockerRunner } from './run-containers';
import { workRootsAt } from './allowed-path';
import { Egress, egressMode } from './egress';
import { imageMissing } from './image-resolver';
import { withEgress } from './egress-launch';
import { projectGitMount } from './project-git';
import { collectEnvMasks } from './env-masks';
import { parseDockerStats } from './docker-stats';
import { containerMemoryCap } from './memory-cap';

export type { DockerRunner };

export interface SandboxChild extends ChildProcess {
  containerName: string;
  /** The memory cap the container started with. Unset for a container that did not go through `spawn`. */
  memoryCapBytes?: number;
}

@Injectable()
export class SandboxService {
  private docker: DockerRunner = defaultDocker;
  private readonly maskFile = join(tmpdir(), 'swarmloop-empty-env');
  private binds: BindMount[] | null = null;
  private egressProxy: Egress | null = null;
  private memoryCap: number | undefined;

  constructor(@Optional() private readonly config?: AppConfig) {}

  useDocker(docker: DockerRunner): void {
    this.docker = docker;
    this.egressProxy = null;
    this.memoryCap = undefined;
  }

  /** Docker's memory less the reserve, the same for every container. Only an answer is kept, so an outage is tried again. */
  private async containerCap(): Promise<number | undefined> {
    this.memoryCap ??= await containerMemoryCap(
      (args, timeoutMs) => this.docker(args, timeoutMs),
      (this.config?.env.RESERVE_MEMORY_GB ?? 2) * 1024 ** 3,
    );
    return this.memoryCap;
  }

  /** The egress proxy all sandboxes go out through. SANDBOX_EGRESS=open turns it off. */
  egress(): Egress | null {
    if (egressMode(rawEnv().SANDBOX_EGRESS) === 'open') {
      return null;
    }
    const root = resolveRepoRoot(rawEnv().SWARMLOOP_ROOT, __dirname);
    const clock = new SystemClock();
    this.egressProxy ??= new Egress({
      docker: (args, timeoutMs) => this.docker(args, timeoutMs),
      policyDir: join(root, 'data', 'egress'),
      daemonPath: async (dir) => (await this.stateDaemonPath(dir)) ?? dir,
      now: () => clock.now(),
      uid: sandboxUserId(),
      own: process.getuid?.() ?? 0,
    });
    return this.egressProxy;
  }

  /** Docker answers and the agent image is on the host. Either failure blocks the run instead of costing an attempt. */
  async assertReady(runtime: RuntimeName): Promise<void> {
    try {
      await this.docker(['info']);
    } catch {
      throw new SwarmloopError('docker is not running', {
        code: ERROR_CODES.DOCKER_UNAVAILABLE,
        category: 'environment',
      });
    }
    const image = agentImage(runtime);
    try {
      await this.docker(['image', 'inspect', image]);
    } catch {
      throw imageMissing(image);
    }
  }

  async spawn(
    given: Omit<SandboxLaunch, 'maskFile' | 'envMasks' | 'workRoots'> & { envMasks?: EnvMask[] },
  ): Promise<SandboxChild> {
    const egress = this.egress();
    const metadata: SandboxMount[] = [];
    let release = () => undefined as void;
    const cleanup = () => {
      release();
      for (const mount of metadata) {
        rmSync(mount.hostPath, { recursive: true, force: true });
      }
    };
    try {
      const memoryCapBytes = await this.containerCap();
      if (given.project && given.statePath) {
        prepareStateDir(given.statePath, given.userId);
        const directory = join(dirname(given.statePath), 'git-metadata');
        mkdirSync(directory, { recursive: true });
        for (const mount of given.mounts) {
          metadata.push(...(await projectGitMount(mount, directory)));
        }
      }
      const prepared = { ...given, mounts: [...given.mounts, ...metadata], memoryCapBytes };
      const acquired = egress ? await withEgress(egress, prepared) : { launch: prepared, release: () => undefined };
      release = acquired.release;
      const { launch } = acquired;
      const child = await this.spawnLaunch(launch);
      child.memoryCapBytes = memoryCapBytes;
      child.once('close', cleanup);
      child.once('error', cleanup);
      return child;
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  private async spawnLaunch(
    launch: Omit<SandboxLaunch, 'maskFile' | 'envMasks' | 'workRoots'> & { envMasks?: EnvMask[] },
  ): Promise<SandboxChild> {
    const mounts = await this.withDaemonPaths(launch.mounts);
    if (launch.statePath) {
      prepareStateDir(launch.statePath, launch.userId);
    }
    const stateDaemonPath = await this.stateDaemonPath(launch.statePath, launch.stateDaemonPath);
    const envMasks = launch.envMasks ?? collectEnvMasks(mounts);
    const maskFile = await this.maskFor(launch.statePath, envMasks.length > 0);
    const env = rawEnv();
    const workRoots = workRootsAt(
      resolveRepoRoot(env.SWARMLOOP_ROOT, __dirname),
      env.CHECKOUTS_ROOT,
      splitList(env.SWARMLOOP_REPOS),
    );
    const full: SandboxLaunch = { ...launch, mounts, workRoots, stateDaemonPath, envMasks, maskFile };
    const args = sandboxArgs(full);
    const network = full.egress ? null : sandboxNetworkName(full.allowHosts);
    if (network) {
      await this.ensureNetwork(
        network,
        full.allowHosts.every((entry) => isLocalHost(hostName(entry))),
      );
    }
    const name = args[args.indexOf('--name') + 1] ?? '';
    await this.remove(name);
    const child = this.spawnDocker(args);
    await barrier('after-container-create');
    return child;
  }

  /** Runs one docker command through the same runner as the other calls. */
  run(args: string[], timeoutMs?: number): Promise<string> {
    return this.docker(args, timeoutMs);
  }

  /** Starts a docker command that streams its output. The caller builds and checks the args. */
  spawnDocker(args: string[]): SandboxChild {
    const stdin = args.slice(0, args.indexOf('--name')).includes('-i') ? 'pipe' : 'ignore';
    const child = spawn('docker', args, { stdio: [stdin, 'pipe', 'pipe'] }) as SandboxChild;
    child.containerName = args[args.indexOf('--name') + 1] ?? '';
    return child;
  }

  async stats(name: string): Promise<{ cpuPercent: number; rssBytes: number }> {
    try {
      const raw = await this.docker(['stats', '--no-stream', '--format', '{{.CPUPerc}} {{.MemUsage}}', name]);
      return parseDockerStats(raw);
    } catch {
      return { cpuPercent: 0, rssBytes: 0 };
    }
  }

  async kill(name: string): Promise<void> {
    try {
      await this.docker(['kill', name]);
    } catch {
      return;
    }
  }

  /**
   * Stops every container of the run: graceful first, then a kill, then a second listing to confirm.
   * 'unknown' when docker did not answer or a container is still listed.
   */
  stopRun(runKey: string, step: string, graceSeconds: number): Promise<'gone' | 'unknown'> {
    return stopRun(this.docker, runKey, step, graceSeconds);
  }

  /** True when docker answers. Read-only: nothing starts, and a failure is false, never a throw. */
  async dockerAnswers(): Promise<boolean> {
    try {
      await this.docker(['info']);
      return true;
    } catch {
      return false;
    }
  }

  /** True while a container of the attempt runs, false when none does, null when docker did not answer. */
  attemptRunning(attemptId: string): Promise<boolean | null> {
    return attemptRunning(this.docker, attemptId);
  }

  /** Kills and removes the containers of an attempt. False when docker did not answer or one is still listed. */
  killAttempt(attemptId: string): Promise<boolean> {
    return killAttempt(this.docker, attemptId);
  }

  /**
   * Removes dangling images and build cache older than 24 hours. Tagged images, volumes and containers stay.
   * A docker that fails is logged: housekeeping never stops a run.
   */
  async pruneDocker(): Promise<void> {
    for (const args of [
      ['image', 'prune', '-f'],
      ['builder', 'prune', '-f', '--filter', 'until=24h'],
    ]) {
      try {
        await this.docker(args, 300_000);
      } catch (error) {
        new Logger(SandboxService.name).warn(
          `docker ${args[0]} prune failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** What docker takes on the disk, as `docker system df` prints it. */
  async dockerUsage(): Promise<string> {
    try {
      return (await this.docker(['system', 'df'])).trim();
    } catch {
      return 'unavailable';
    }
  }

  async remove(name: string): Promise<void> {
    try {
      await this.docker(['rm', '-f', name]);
    } catch {
      return;
    }
  }

  /** True while the container is running, false when it is gone or stopped, null when docker did not answer. */
  async containerExists(name: string): Promise<boolean | null> {
    try {
      const raw = await this.docker(['inspect', '--format', '{{.State.Running}}', name]);
      return raw.trim() === 'true';
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (text.includes('No such object') || text.includes('No such container')) {
        return false;
      }
      return null;
    }
  }

  async maskFor(statePath: string | undefined, needed: boolean): Promise<string> {
    if (!needed) {
      return this.maskFile;
    }
    const local = statePath ? emptyEnvFile(statePath) : this.maskFile;
    ensureMaskFile(local);
    return resolveDaemonPath(local, await this.ownBinds());
  }

  async stateDaemonPath(path?: string, given?: string): Promise<string | undefined> {
    if (given) {
      return given;
    }
    if (!path) {
      return undefined;
    }
    return resolveDaemonPath(path, await this.ownBinds());
  }

  async withDaemonPaths(mounts: SandboxMount[]): Promise<SandboxMount[]> {
    const binds = await this.ownBinds();
    return mounts.map((mount) => {
      if (mount.volume || mount.daemonPath) {
        return mount;
      }
      return { ...mount, daemonPath: resolveDaemonPath(mount.hostPath, binds) };
    });
  }

  private async ownBinds(): Promise<BindMount[]> {
    if (this.binds) {
      return this.binds;
    }
    try {
      const id = readFileSync('/etc/hostname', 'utf8').trim();
      const raw = await this.docker(['inspect', '--format', '{{json .Mounts}}', id]);
      const parsed = JSON.parse(raw) as { Type?: string; Destination?: string; Source?: string }[];
      this.binds = parsed
        .filter((mount) => mount.Type === 'bind' && mount.Destination && mount.Source)
        .map((mount) => ({ destination: mount.Destination ?? '', source: mount.Source ?? '' }));
    } catch {
      this.binds = [];
    }
    return this.binds;
  }

  async ensureNetwork(name: string, internal: boolean): Promise<void> {
    try {
      await this.docker(['network', 'inspect', name]);
    } catch {
      const args = ['network', 'create'];
      if (internal) {
        args.push('--internal');
      }
      args.push(name);
      await this.docker(args);
    }
  }
}

function ensureMaskFile(path: string): void {
  if (existsSync(path)) {
    return;
  }
  mkdirSync(tmpdir(), { recursive: true });
  closeSync(openSync(path, 'a'));
}

function defaultDocker(args: string[], timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { encoding: 'utf8', timeout: timeoutMs }, (error, stdout) => {
      if (error) {
        reject(new Error(error.message, { cause: error }));
        return;
      }
      resolve(stdout);
    });
  });
}
