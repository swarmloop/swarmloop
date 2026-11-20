import type { DockerRunner } from './run-containers';

/** What the Docker daemon has: its CPUs and its memory in bytes. */
export interface DockerMachine {
  cpus: number;
  memoryBytes: number;
}

/** `undefined` when docker fails or gives anything but two finite positive numbers. */
export async function readDockerMachine(docker: DockerRunner): Promise<DockerMachine | undefined> {
  try {
    const fields = (await docker(['info', '--format', '{{.NCPU}} {{.MemTotal}}'])).trim().split(/\s+/);
    if (fields.length !== 2) {
      return undefined;
    }
    const [cpus, memoryBytes] = fields.map(Number);
    if (!Number.isFinite(cpus) || !Number.isFinite(memoryBytes) || cpus <= 0 || memoryBytes <= 0) {
      return undefined;
    }
    return { cpus, memoryBytes };
  } catch {
    return undefined;
  }
}

/** The Docker Engine version, such as `26.1.4`; `undefined` when docker fails or the answer is no version. */
export async function readDockerEngine(docker: DockerRunner): Promise<string | undefined> {
  try {
    const version = (await docker(['version', '--format', '{{.Server.Version}}'])).trim();
    return /^\d+(\.\d+)*([-+.]\S*)?$/.test(version) ? version : undefined;
  } catch {
    return undefined;
  }
}
