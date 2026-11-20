import { readFileSync } from 'fs';
import type { SandboxMount } from '../core/sandbox-mount';
import { covers, realPathOf, resolveDaemonPath } from './sandbox-launch';
import type { BindMount } from './sandbox-launch';
import type { DockerRunner } from './run-containers';

interface VolumeMount {
  name: string;
  destination: string;
}

export type DaemonPlace = { volume: string; subpath: string } | { path: string };

/** The mount of the server's own container that covers the real path with the longest destination. */
function longest<T extends { destination: string }>(mounts: T[], real: string): T | undefined {
  return mounts
    .filter((mount) => covers(mount.destination, real))
    .sort((left, right) => right.destination.length - left.destination.length)[0];
}

/** Gives a server path its place on the daemon: a volume with a subpath, or a bind source path. */
function resolveOwnMount(mount: SandboxMount, own: { binds: BindMount[]; volumes: VolumeMount[] }): SandboxMount {
  const real = realPathOf(mount.hostPath);
  const volume = longest(own.volumes, real);
  const bind = longest(own.binds, real);
  if (volume && (!bind || volume.destination.length > bind.destination.length)) {
    return { ...mount, volume: volume.name, volumeSubpath: real.slice(volume.destination.length).replace(/^\//, '') };
  }
  return { ...mount, daemonPath: resolveDaemonPath(mount.hostPath, own.binds) };
}

/** What the server's own container has mounted, read once from docker. */
export class OwnMounts {
  private own: { binds: BindMount[]; volumes: VolumeMount[] } | null = null;

  constructor(private readonly docker: () => DockerRunner) {}

  async resolveBind(path: string): Promise<string> {
    return resolveDaemonPath(path, (await this.read()).binds);
  }

  async withDaemonPaths(mounts: SandboxMount[]): Promise<SandboxMount[]> {
    const own = await this.read();
    return mounts.map((mount) => (mount.volume || mount.daemonPath ? mount : resolveOwnMount(mount, own)));
  }

  async daemonPlace(dir: string): Promise<DaemonPlace> {
    const mount = resolveOwnMount({ hostPath: dir, containerPath: dir }, await this.read());
    if (mount.volume !== undefined) {
      return { volume: mount.volume, subpath: mount.volumeSubpath ?? '' };
    }
    return { path: mount.daemonPath ?? dir };
  }

  private async read(): Promise<{ binds: BindMount[]; volumes: VolumeMount[] }> {
    if (this.own) {
      return this.own;
    }
    try {
      const id = readFileSync('/etc/hostname', 'utf8').trim();
      const raw = await this.docker()(['inspect', '--format', '{{json .Mounts}}', id]);
      const parsed = JSON.parse(raw) as { Type?: string; Name?: string; Destination?: string; Source?: string }[];
      this.own = {
        binds: parsed
          .filter((mount) => mount.Type === 'bind' && mount.Destination && mount.Source)
          .map((mount) => ({ destination: mount.Destination ?? '', source: mount.Source ?? '' })),
        volumes: parsed
          .filter((mount) => mount.Type === 'volume' && mount.Destination && mount.Name)
          .map((mount) => ({ destination: mount.Destination ?? '', name: mount.Name ?? '' })),
      };
    } catch {
      this.own = { binds: [], volumes: [] };
    }
    return this.own;
  }
}
