import type { CpuSlice, SandboxLaunch } from './sandbox-types';

/** The cores one container gets: an equal share for each of the places, and at least one. */
export function sliceSize(cores: number, places: number): number {
  return Math.max(1, Math.floor(cores / places));
}

/** The cores of a slice as a list: `a`, a range `a-b`, or a comma list in order when the slice wraps round the last core. */
export function coreListText(slice: CpuSlice): string {
  const size = sliceSize(slice.cores, slice.places);
  const cores = Array.from({ length: size }, (_, offset) => (slice.index * size + offset) % slice.cores);
  const first = cores[0] ?? 0;
  const last = cores[cores.length - 1] ?? first;
  if (cores.length === 1) {
    return String(first);
  }
  return last === first + cores.length - 1 ? `${first}-${last}` : cores.join(',');
}

/** Chooses the slice of each project container: a check by its place, any other by turns over all the cores. */
export class CoreTurns {
  private turn = 0;

  sliceFor(
    machine: { cpus: number } | undefined,
    places: number,
    launch: Pick<SandboxLaunch, 'project' | 'checkPlace'>,
  ): CpuSlice | undefined {
    if (!launch.project || !machine) {
      return undefined;
    }
    if (launch.checkPlace !== undefined) {
      return { cores: machine.cpus, places, index: launch.checkPlace };
    }
    const index = this.turn;
    this.turn += 1;
    return { cores: machine.cpus, places, index };
  }
}
