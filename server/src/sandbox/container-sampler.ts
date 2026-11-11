import type { Clock } from '../core/clock';

/** One reading of a container, with what it is the reading of. */
interface Sample {
  sampledAt: string;
  cpuPercent: number;
  rssBytes: number;
  source: string;
}

interface StatsSource {
  stats(containerName: string): Promise<{ cpuPercent: number; rssBytes: number }>;
}

/**
 * One sampler for every container swarmloop starts for a run. Each call takes one sample of the container and hands
 * it, with its source, to `sink`. A call while the previous sample is still being taken does nothing.
 */
export function containerSampler(
  sandbox: StatsSource,
  clock: Pick<Clock, 'iso'>,
  containerName: string,
  source: string,
  sink: (sample: Sample) => void,
): () => void {
  let sampling = false;
  return () => {
    if (sampling) {
      return;
    }
    sampling = true;
    void sandbox
      .stats(containerName)
      .then((sample) => sink({ sampledAt: clock.iso(), source, ...sample }))
      .finally(() => {
        sampling = false;
      });
  };
}
