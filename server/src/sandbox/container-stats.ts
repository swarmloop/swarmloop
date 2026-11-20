import type { Clock } from '../core/clock';
import { SAMPLE_MS } from '../core/awake-time';
import { parseDockerStatsListing } from './docker-stats';
import type { RunningWork } from './running-work';

type Sample = { cpuPercent: number; rssBytes: number };
type Listing = Map<string, Sample>;

/** One `docker stats` call lists every running container; callers inside a SAMPLE_MS window share it. */
export class ContainerStats {
  private window: { startedAt: number; listing: Promise<Listing> } | null = null;

  constructor(
    private readonly docker: (args: string[]) => Promise<string>,
    private readonly work: RunningWork,
    private readonly clock: Clock,
  ) {}

  async sample(name: string): Promise<Sample> {
    const sample = (await this.listing()).get(name);
    if (!sample) {
      return { cpuPercent: 0, rssBytes: 0 };
    }
    this.work.sample(name, sample);
    return sample;
  }

  private listing(): Promise<Listing> {
    const now = this.clock.now();
    if (!this.window || now - this.window.startedAt >= SAMPLE_MS) {
      this.window = { startedAt: now, listing: this.list() };
    }
    return this.window.listing;
  }

  private async list(): Promise<Listing> {
    try {
      return parseDockerStatsListing(
        await this.docker(['stats', '--no-stream', '--format', '{{.Name}} {{.CPUPerc}} {{.MemUsage}}']),
      );
    } catch {
      return new Map();
    }
  }
}
