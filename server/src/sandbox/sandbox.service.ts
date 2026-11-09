import { spawn, ChildProcess, execFile } from 'child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, statSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { Injectable, Logger } from '@nestjs/common';
import { rawEnv } from '../config/process-env';
import { resolveRepoRoot } from '../config/repo-root';
import { SystemClock } from '../core/clock';
import { RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';
import { barrier } from '../core/barrier';
import { SwarmloopError } from '../core/swarmloop-error';
import type { SandboxMount } from '../core/sandbox-mount';
import {
  BindMount,
  containerName,
  emptyEnvFile,
  EnvMask,
  agentImage,
  isLocalHost,
  prepareStateDir,
  SandboxLaunch,
  resolveDaemonPath,
  sandboxArgs,
  sandboxNetworkName,
  sandboxUserId,
  hostName,
  stepContainers,
} from '../sandbox/sandbox-launch';
import { Egress, egressMode } from './egress';
import { ImagePreparation } from './image-prepare';
import type { RunImages } from './image-resolver';
import { withEgress } from './egress-launch';
import { projectGitMount } from './project-git';

export type DockerRunner = (args: string[], timeoutMs?: number) => Promise<string>;

export interface SandboxChild extends ChildProcess {
  containerName: string;
}

@Injectable()
export class SandboxService {
  private docker: DockerRunner = defaultDocker;
  private readonly maskFile = join(tmpdir(), 'swarmloop-empty-env');
  private binds: BindMount[] | null = null;
  private egressProxy: Egress | null = null;
  /** The images each run started with, as its `images` document says. A launch of the run uses these. */
  private readonly runImages = new Map<string, RunImages>();
  /** Pulls and checks the release images before a launch. It runs on whatever docker runner is set. */
  readonly images = new ImagePreparation((args, timeoutMs) => this.docker(args, timeoutMs));

  useDocker(docker: DockerRunner): void {
    this.docker = docker;
    this.egressProxy = null;
  }

  /** The images this process already made ready for the run, so its later launches check nothing again. */
  imagesOf(runKey: string): RunImages | undefined {
    return this.runImages.get(runKey);
  }

  startedWith(runKey: string, images: RunImages): void {
    this.runImages.set(runKey, images);
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

  async assertReady(runtime: RuntimeName): Promise<void> {
    await this.images.dockerUp();
    const image = agentImage(runtime);
    if (image.registry) {
      return;
    }
    try {
      await this.docker(['image', 'inspect', image.ref]);
    } catch {
      throw new SwarmloopError('sandbox image is missing');
    }
  }

  async spawn(given: Omit<SandboxLaunch, 'maskFile' | 'envMasks'> & { envMasks?: EnvMask[] }): Promise<SandboxChild> {
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
      if (given.project && given.statePath) {
        prepareStateDir(given.statePath, given.userId);
        const directory = join(dirname(given.statePath), 'git-metadata');
        mkdirSync(directory, { recursive: true });
        for (const mount of given.mounts) {
          metadata.push(...(await projectGitMount(mount, directory)));
        }
      }
      const images = given.images ?? this.runImages.get(given.runKey);
      const prepared = { ...given, ...(images ? { images } : {}), mounts: [...given.mounts, ...metadata] };
      const acquired = egress ? await withEgress(egress, prepared) : { launch: prepared, release: () => undefined };
      release = acquired.release;
      const { launch } = acquired;
      const child = await this.spawnLaunch(launch);
      child.once('close', cleanup);
      child.once('error', cleanup);
      return child;
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  private async spawnLaunch(
    launch: Omit<SandboxLaunch, 'maskFile' | 'envMasks'> & { envMasks?: EnvMask[] },
  ): Promise<SandboxChild> {
    const mounts = await this.withDaemonPaths(launch.mounts);
    if (launch.statePath) {
      prepareStateDir(launch.statePath, launch.userId);
    }
    const stateDaemonPath = await this.stateDaemonPath(launch.statePath, launch.stateDaemonPath);
    const envMasks = launch.envMasks ?? collectEnvMasks(mounts);
    const maskFile = await this.maskFor(launch.statePath, envMasks.length > 0);
    const full: SandboxLaunch = { ...launch, mounts, stateDaemonPath, envMasks, maskFile };
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
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }) as SandboxChild;
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
  async stopRun(runKey: string, step: string, graceSeconds: number): Promise<'gone' | 'unknown'> {
    try {
      const listed = await this.runContainers(runKey, step);
      for (const id of listed) {
        await this.dockerAllowingGone(['stop', '-t', String(graceSeconds), id], (graceSeconds + 30) * 1000);
      }
      for (const id of listed) {
        await this.dockerAllowingGone(['kill', id], 30_000);
      }
      return (await this.runContainers(runKey, step)).length === 0 ? 'gone' : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** The containers of a run by label. Containers from before the labels are found by name. Throws when docker fails. */
  private async runContainers(runKey: string, step: string): Promise<string[]> {
    const labeled = await this.listed(['ps', '-q', '--filter', `label=swarmloop.run=${runKey}`]);
    const base = containerName(runKey, step);
    const fallback = await this.listed(['ps', '--filter', `name=${base}`, '--format', '{{.Names}}']);
    return [...new Set([...labeled, ...stepContainers(base, fallback)])];
  }

  private async listed(args: string[]): Promise<string[]> {
    const raw = await this.docker(args);
    return raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  /** Runs a stop or kill. A container that is already gone is the goal, not an error. */
  private async dockerAllowingGone(args: string[], timeoutMs: number): Promise<void> {
    try {
      await this.docker(args, timeoutMs);
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      if (!text.includes('No such container') && !text.includes('is not running')) {
        throw error;
      }
    }
  }

  /** True while a container of the attempt runs, false when none does, null when docker did not answer. */
  async attemptRunning(attemptId: string): Promise<boolean | null> {
    try {
      return (await this.listed(['ps', '-q', '--filter', `label=swarmloop.attempt=${attemptId}`])).length > 0;
    } catch {
      return null;
    }
  }

  /** Kills and removes the containers of an attempt. False when docker did not answer or one is still listed. */
  async killAttempt(attemptId: string): Promise<boolean> {
    try {
      for (const id of await this.listed(['ps', '-aq', '--filter', `label=swarmloop.attempt=${attemptId}`])) {
        await this.dockerAllowingGone(['rm', '-f', id], 30_000);
      }
      return (await this.attemptRunning(attemptId)) === false;
    } catch {
      return false;
    }
  }

  /**
   * Removes dangling images and build cache older than 24 hours. Tagged images, volumes and containers stay, and so
   * do the images in `keep`, which runs in flight started with. `image prune` has no exclude list, so with images to
   * keep the dangling ones are removed one by one.
   * A docker that fails is logged: housekeeping never stops a run.
   */
  async pruneDocker(keep: RunImages[] = []): Promise<void> {
    for (const [name, step] of [
      ['image', () => (keep.length === 0 ? this.docker(['image', 'prune', '-f'], 300_000) : this.removeDangling(keep))],
      ['builder', () => this.docker(['builder', 'prune', '-f', '--filter', 'until=24h'], 300_000)],
    ] as const) {
      try {
        await step();
      } catch (error) {
        new Logger(SandboxService.name).warn(
          `docker ${name} prune failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  /** Removes the dangling images that no run in `keep` uses. They match by image id or by the digest of the reference. */
  private async removeDangling(keep: RunImages[]): Promise<void> {
    const used = keep.flatMap((images) => [images.agent, images.egress]);
    const ids = used.map((image) => image.id?.replace('sha256:', '')).filter((id): id is string => !!id);
    const digests = used.map((image) => image.ref.split('@')[1]).filter((digest): digest is string => !!digest);
    for (const line of await this.listed('image ls --filter dangling=true --format {{.ID}}/{{.Digest}}'.split(' '))) {
      const [id, digest] = line.split('/');
      if (!ids.some((kept) => kept.startsWith(id) || id.startsWith(kept)) && !digests.includes(digest)) {
        try {
          await this.docker(['image', 'rm', id], 300_000);
        } catch (error) {
          new Logger(SandboxService.name).warn(
            `docker image rm ${id} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
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

export function collectEnvMasks(mounts: { hostPath: string; containerPath: string }[]): EnvMask[] {
  const masks: EnvMask[] = [];
  for (const mount of mounts) {
    if (mount.containerPath.endsWith('/.git') || mount.containerPath.startsWith('/swarmloop-git/')) {
      continue;
    }
    walkEnv(mount.hostPath, mount.containerPath, masks);
  }
  return masks;
}

function walkEnv(host: string, container: string, masks: EnvMask[]): void {
  if (!existsSync(host) || !statSync(host).isDirectory()) {
    return;
  }
  for (const entry of readdirSync(host, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules') {
      continue;
    }
    const hostPath = join(host, entry.name);
    const containerFile = `${container}/${entry.name}`;
    if (entry.isDirectory()) {
      walkEnv(hostPath, containerFile, masks);
      continue;
    }
    if (entry.name === '.env' || (entry.name.startsWith('.env.') && entry.name !== '.env.example')) {
      masks.push({ hostFile: hostPath, containerFile });
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

export function parseDockerStats(raw: string): { cpuPercent: number; rssBytes: number } {
  const cpu = /^([\d.]+)%/.exec(raw.trim());
  const memory = /([\d.]+)\s*([KMGT]?i?B)/i.exec(raw);
  return {
    cpuPercent: cpu ? Number(cpu[1]) : 0,
    rssBytes: memory ? memoryBytes(Number(memory[1]), memory[2] ?? 'B') : 0,
  };
}

function memoryBytes(value: number, unit: string): number {
  const scale: Record<string, number> = {
    B: 1,
    KB: 1_000,
    KiB: 1_024,
    MB: 1_000_000,
    MiB: 1_024 * 1_024,
    GB: 1_000_000_000,
    GiB: 1_024 * 1_024 * 1_024,
    TB: 1_000_000_000_000,
    TiB: 1_024 * 1_024 * 1_024 * 1_024,
  };
  return Math.round(value * (scale[unit] ?? 1));
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
