import type { DockerMachine } from './docker-machine';
import { readDockerMachine } from './docker-machine';
import type { DockerRunner } from './run-containers';

/**
 * The memory one sandbox container may take: what the Docker daemon has, less the reserve the server and the
 * dashboard keep. `undefined` when docker gives no usable answer, so the container then runs without a cap.
 */
export async function containerMemoryCap(docker: DockerRunner, reserveBytes: number): Promise<number | undefined> {
  return memoryCapOf(await readDockerMachine(docker), reserveBytes);
}

export function memoryCapOf(machine: DockerMachine | undefined, reserveBytes: number): number | undefined {
  if (!machine) {
    return undefined;
  }
  const cap = machine.memoryBytes - reserveBytes;
  return Number.isFinite(cap) && cap > 0 ? cap : undefined;
}
