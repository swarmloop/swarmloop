import { relative, sep } from 'path';
import { remoteProject } from '../integrations/code-host/remote-project';
import type { SandboxMount } from '../core/sandbox-mount';
import type { CloneOriginsView, ShellMount } from '../contract/shell';

/** The top folder and the `origin` URL of the clone that holds a host path. */
export interface HostClone {
  top: string;
  origin: string;
}

/** Map a host path in a clone to the server's clone of the same project, matched by origin. */
export function nestCheckout(
  hostPath: string,
  hostClone: HostClone | null,
  clones: CloneOriginsView['clones'],
): string {
  if (hostClone === null) {
    return hostPath;
  }
  const wanted = identity(hostClone.origin);
  const clone = wanted === null ? undefined : clones.find((item) => identity(item.origin) === wanted);
  if (!clone) {
    return hostPath;
  }
  const inside = relative(hostClone.top, hostPath);
  return inside.length === 0 ? clone.path : `${clone.path}/${inside.split(sep).join('/')}`;
}

/** Turn a mount of the server's view into the mount the shell container launches. */
export function hostCheckout(mount: ShellMount): SandboxMount {
  return {
    hostPath: mount.hostPath,
    containerPath: mount.containerPath,
    volume: mount.volume,
    volumeSubpath: mount.volumeSubpath,
  };
}

function identity(origin: string): string | null {
  try {
    const { host, project } = remoteProject(origin);
    return `${host.toLowerCase()}/${project.toLowerCase()}`;
  } catch {
    return null;
  }
}
