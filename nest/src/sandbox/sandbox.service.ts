import { spawn, ChildProcess, execFile } from 'child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Injectable } from '@nestjs/common';
import { SwarmloopError } from '../swarmloop-error';
import { BindMount, containerName, emptyEnvFile, EnvMask, imageName, isLocalHost, prepareStateDir, SandboxLaunch, SandboxMount, resolveDaemonPath, sandboxArgs, sandboxNetworkName, hostName, stepContainers } from './sandbox-launch';

export type DockerRunner = (args: string[]) => Promise<string>;

export interface SandboxChild extends ChildProcess {
  containerName: string;
}

@Injectable()
export class SandboxService {
  private docker: DockerRunner = defaultDocker;
  private readonly maskFile = join(tmpdir(), 'swarmloop-empty-env');
  private binds: BindMount[] | null = null;

  useDocker(docker: DockerRunner): void {
    this.docker = docker;
  }

  async assertReady(runtime: 'cursor' | 'claude'): Promise<void> {
    try {
      await this.docker(['info']);
    } catch {
      throw new SwarmloopError('docker is not running');
    }
    try {
      await this.docker(['image', 'inspect', imageName(runtime)]);
    } catch {
      throw new SwarmloopError('sandbox image is missing');
    }
  }

  async spawn(launch: Omit<SandboxLaunch, 'maskFile' | 'envMasks'> & { envMasks?: EnvMask[] }): Promise<SandboxChild> {
    const mounts = await this.withDaemonPaths(launch.mounts);
    if (launch.statePath) {
      prepareStateDir(launch.statePath, launch.userId);
    }
    const stateDaemonPath = await this.stateDaemonPath(launch.statePath, launch.stateDaemonPath);
    const envMasks = launch.envMasks ?? collectEnvMasks(mounts);
    const maskFile = await this.maskFor(launch.statePath, envMasks.length > 0);
    const full: SandboxLaunch = { ...launch, mounts, stateDaemonPath, envMasks, maskFile };
    const args = sandboxArgs(full);
    const network = sandboxNetworkName(full.allowHosts);
    if (network) {
      await this.ensureNetwork(network, full.allowHosts.every((entry) => isLocalHost(hostName(entry))));
    }
    const name = args[args.indexOf('--name') + 1] ?? '';
    await this.remove(name);
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }) as SandboxChild;
    child.containerName = name;
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

  /** Stops the step container and every fan-out container under that name. */
  async killFamily(runKey: string, step: string): Promise<void> {
    const base = containerName(runKey, step);
    await this.kill(base);
    let listed = '';
    try {
      listed = await this.docker(['ps', '--filter', `name=${base}`, '--format', '{{.Names}}']);
    } catch {
      return;
    }
    const names = stepContainers(
      base,
      listed
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0),
    );
    for (const name of names) {
      if (name !== base) {
        await this.kill(name);
      }
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

  private async maskFor(statePath: string | undefined, needed: boolean): Promise<string> {
    if (!needed) {
      return this.maskFile;
    }
    const local = statePath ? emptyEnvFile(statePath) : this.maskFile;
    ensureMaskFile(local);
    return resolveDaemonPath(local, await this.ownBinds());
  }

  private async stateDaemonPath(path?: string, given?: string): Promise<string | undefined> {
    if (given) {
      return given;
    }
    if (!path) {
      return undefined;
    }
    return resolveDaemonPath(path, await this.ownBinds());
  }

  private async withDaemonPaths(mounts: SandboxMount[]): Promise<SandboxMount[]> {
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

  private async ensureNetwork(name: string, internal: boolean): Promise<void> {
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
    walkEnv(mount.hostPath, mount.containerPath, masks);
  }
  return masks;
}

function walkEnv(host: string, container: string, masks: EnvMask[]): void {
  if (!existsSync(host)) {
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

function defaultDocker(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { encoding: 'utf8', timeout: 30_000 }, (error, stdout) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(stdout);
    });
  });
}
