import type { DockerMachine } from './docker-machine';

export function memoryCapOf(machine: DockerMachine | undefined, reserveBytes: number): number | undefined {
  if (!machine) {
    return undefined;
  }
  const cap = machine.memoryBytes - reserveBytes;
  return Number.isFinite(cap) && cap > 0 ? cap : undefined;
}
