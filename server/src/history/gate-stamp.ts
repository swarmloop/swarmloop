import type { RunEntity } from './entities';

/** What a gate was written for: the generation of the run and the files it judged. */
export interface GateStamp {
  generation: number;
  fingerprint: string;
}

/** True only when the generation and the fingerprint both match. A gate without a stamp does not count. */
export function countsFor(
  run: Pick<RunEntity, 'generation'>,
  stamp: Partial<GateStamp> | null | undefined,
  fingerprint: string,
): boolean {
  return stamp?.generation === run.generation && stamp.fingerprint === fingerprint;
}
