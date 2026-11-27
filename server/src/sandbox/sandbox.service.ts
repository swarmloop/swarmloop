import { spawn, ChildProcess } from 'child_process';
import { mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { Injectable, Logger, OnModuleDestroy, Optional } from '@nestjs/common';
import { AppConfig, splitList } from '../config/env';
import { rawEnv } from '../config/process-env';
import { resolveRepoRoot } from '../config/repo-root';
import { Clock, SystemClock } from '../core/clock';
import { RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';
import { barrier } from '../core/barrier';
import { ERROR_CODES } from '../contract/error-codes';
import { SwarmloopError } from '../core/swarmloop-error';
import type { SandboxMount } from '../core/sandbox-mount';
import {
  emptyEnvFile,
  EnvMask,
  agentImage,
  prepareStateDir,
  SandboxLaunch,
  sandboxArgs,
  sandboxUserId,
} from '../sandbox/sandbox-launch';
import { hostName, isLocalHost, sandboxNetworkName } from './sandbox-hosts';
import { attemptAwaited, attemptRunning, killAttempt, stopRun } from './run-containers';
import type { DockerRunner } from './run-containers';
import { workRootsAt } from './allowed-path';
import { emptyWorkPath } from './empty-work-mount';
import { Egress, egressMode } from './egress';
import { imageMissing } from './image-resolver';
import { withEgress } from './egress-launch';
import { projectGitMount } from './project-git';
import { collectEnvMasks, ensureMaskFile } from './env-masks';
import { defaultDocker } from './default-docker';
import type { DockerMachine } from './docker-machine';
import { RunningWork } from './running-work';
import { ContainerStats } from './container-stats';
import { MachineLimits } from './machine-limits';
import { ContainerGate } from './container-gate';
import { MetadataRemoval } from './metadata-removal';
import { OwnMounts } from './own-mounts';
import type { DaemonPlace } from './own-mounts';
import { handToSandbox, SandboxOwnership } from './sandbox-owner';
import type { AgentHold } from './container-gate';

export type { DockerRunner };

export interface SandboxChild extends ChildProcess {
  containerName: string;
  /** The memory cap the container started with. Unset for a container that did not go through `spawn`. */
  memoryCapBytes?: number;
}

@Injectable()
export class SandboxService implements OnModuleDestroy {
  private docker: DockerRunner = defaultDocker;
  private readonly maskFile = join(tmpdir(), 'swarmloop-empty-env');
  private readonly ownMounts = new OwnMounts(() => this.docker);
  private ownership = new SandboxOwnership();
  private egressProxy: Egress | null = null;
  private readonly limits: MachineLimits;

  readonly gate: ContainerGate;
  readonly work: RunningWork;
  private readonly metadataRemoval = new MetadataRemoval();
  private readonly containerStats: ContainerStats;

  constructor(
    @Optional() private readonly config?: AppConfig,
    @Optional() gate?: ContainerGate,
    @Optional() work?: RunningWork,
    @Optional() clock?: Clock,
  ) {
    this.gate = gate ?? new ContainerGate(config);
    this.work = work ?? new RunningWork();
    this.limits = new MachineLimits(() => this.docker, config);
    this.containerStats = new ContainerStats((args) => this.docker(args), this.work, clock ?? new SystemClock());
  }

  async onModuleDestroy(): Promise<void> {
    await this.metadataRemoval.drained();
  }

  useDocker(docker: DockerRunner): void {
    this.docker = docker;
    this.egressProxy = null;
    this.limits.forget();
  }

  /** Replaces the hand-over of a mounted tree to the sandbox user. */
  useHandOver(handOver: typeof handToSandbox): void {
    this.ownership = new SandboxOwnership(handOver);
  }

  /** Prepares writable volume subpaths once per Git index and user, shared by the server's containers. */
  prepareMounts(mounts: SandboxMount[], uid: number): Promise<string[]> {
    return this.ownership.prepare(mounts, uid);
  }

  /** Docker's CPUs and memory. Only an answer is kept, so an outage is tried again. */
  machine(): Promise<DockerMachine | undefined> {
    return this.limits.machine();
  }

  /** The kept answer of `machine()`; no docker call. */
  knownMachine(): DockerMachine | undefined {
    return this.limits.knownMachine();
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

  /**
   * With `held`, the container waits while the server is paused (`onPaused` says so once) and is counted until it ends.
   * With `held.agent`, it also waits while AGENTS_PARALLEL agent containers run.
   * Without it, the container starts at once and is not counted.
   */
  async spawn(
    given: Omit<SandboxLaunch, 'maskFile' | 'envMasks' | 'workRoots' | 'emptyWork'> & { envMasks?: EnvMask[] },
    held?: { onPaused: () => void; agent?: AgentHold; work?: 'check' | 'setup' },
  ): Promise<SandboxChild> {
    const egress = this.egress();
    const admitted = held ? await this.gate.admit(held.onPaused, given.runKey, held.agent) : () => undefined;
    const metadata: SandboxMount[] = [];
    let release = () => undefined as void;
    let started = '';
    const cleanup = () => {
      this.work.end(started);
      admitted();
      release();
      this.metadataRemoval.remove(metadata.map((mount) => mount.hostPath));
    };
    try {
      const memoryCapBytes = await this.limits.containerCap();
      if (given.project && given.statePath) {
        prepareStateDir(given.statePath, given.userId);
        const directory = join(dirname(given.statePath), 'git-metadata');
        mkdirSync(directory, { recursive: true });
        for (const mount of given.mounts) {
          metadata.push(...(await projectGitMount(mount, directory)));
        }
      }
      const cpuSlice = given.cpuSlice !== undefined ? (given.cpuSlice ?? undefined) : this.limits.coreSlice(given);
      const prepared = { ...given, mounts: [...given.mounts, ...metadata], memoryCapBytes, cpuSlice };
      const acquired = egress ? await withEgress(egress, prepared) : { launch: prepared, release: () => undefined };
      release = acquired.release;
      const { launch } = acquired;
      const child = await this.spawnLaunch(launch);
      child.memoryCapBytes = memoryCapBytes;
      const kind = held?.agent ? 'agent' : held?.work;
      if (kind) {
        started = child.containerName;
        this.work.start(started, kind);
      }
      child.once('close', cleanup);
      child.once('error', cleanup);
      return child;
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  private async spawnLaunch(
    launch: Omit<SandboxLaunch, 'maskFile' | 'envMasks' | 'workRoots' | 'emptyWork'> & { envMasks?: EnvMask[] },
  ): Promise<SandboxChild> {
    const mounts = await this.withDaemonPaths(launch.mounts);
    const tmp = launch.tmp ? (await this.withDaemonPaths([launch.tmp]))[0] : undefined;
    await this.prepareMounts(mounts, launch.userId);
    if (launch.statePath) {
      prepareStateDir(launch.statePath, launch.userId);
    }
    const stateDaemonPath = await this.stateDaemonPath(launch.statePath, launch.stateDaemonPath);
    const envMasks = launch.envMasks ?? (await collectEnvMasks(mounts));
    const maskFile = await this.maskFor(launch.statePath, envMasks.length > 0);
    const env = rawEnv();
    const root = resolveRepoRoot(env.SWARMLOOP_ROOT, __dirname);
    const workRoots = workRootsAt(root, env.CHECKOUTS_ROOT, splitList(env.SWARMLOOP_REPOS));
    const full: SandboxLaunch = {
      ...launch,
      mounts,
      ...(tmp ? { tmp } : {}),
      workRoots,
      emptyWork: emptyWorkPath(root),
      stateDaemonPath,
      envMasks,
      maskFile,
    };
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
    return this.containerStats.sample(name);
  }

  async kill(name: string): Promise<void> {
    try {
      await this.docker(['kill', name]);
    } catch {
      return;
    }
  }

  /**
   * Takes the run's containers out of a pause's wait, then stops every container of it: graceful first, then a kill, then a second listing to confirm.
   * 'unknown' when docker did not answer or a container is still listed.
   */
  stopRun(runKey: string, step: string, graceSeconds: number): Promise<'gone' | 'unknown'> {
    this.gate.drop(runKey);
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

  /** True when a running container of the attempt can still give its result, false when none can, null when docker did not answer. */
  attemptAwaited(attemptId: string): Promise<boolean | null> {
    return attemptAwaited(this.docker, attemptId);
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

  async maskFor(statePath: string | undefined, needed: boolean): Promise<string> {
    if (!needed) {
      return this.maskFile;
    }
    const local = statePath ? emptyEnvFile(statePath) : this.maskFile;
    ensureMaskFile(local);
    return this.ownMounts.resolveBind(local);
  }

  async stateDaemonPath(path?: string, given?: string): Promise<string | undefined> {
    if (given) {
      return given;
    }
    if (!path) {
      return undefined;
    }
    return this.ownMounts.resolveBind(path);
  }

  withDaemonPaths(mounts: SandboxMount[]): Promise<SandboxMount[]> {
    return this.ownMounts.withDaemonPaths(mounts);
  }

  /** Where the daemon finds a server folder: a volume with a subpath, or a path. */
  daemonPlace(dir: string): Promise<DaemonPlace> {
    return this.ownMounts.daemonPlace(dir);
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
