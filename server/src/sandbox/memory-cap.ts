import type { DockerRunner } from './run-containers';

/**
 * The memory one sandbox container may take: what the Docker daemon has, less the reserve the server and the
 * dashboard keep. `undefined` when docker gives no usable answer, so the container then runs without a cap.
 */
export async function containerMemoryCap(docker: DockerRunner, reserveBytes: number): Promise<number | undefined> {
  try {
    const total = Number((await docker(['info', '--format', '{{.MemTotal}}'])).trim());
    const cap = total - reserveBytes;
    return Number.isFinite(cap) && cap > 0 ? cap : undefined;
  } catch {
    return undefined;
  }
}
