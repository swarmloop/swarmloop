import { SwarmloopError } from '../core/swarmloop-error';
import type { Footprint, HeavyWork } from '../core/heavy-work';
import type { MachineLoad } from '../contract/readiness';
import type { DockerRunner } from './run-containers';

interface Reserve {
  cpus: number;
  memoryBytes: number;
}

interface Limit {
  cpus: number;
  memoryBytes: number;
}

interface Entry {
  work: HeavyWork;
  footprint: Footprint;
  /** Runs only with nothing beside it, and nothing starts beside it: asked for, or larger than the whole budget. */
  exclusive: boolean;
  start: () => void;
  cancel: (error: Error) => void;
  onWait?: (reason: string) => void;
  told: string | null;
}

/**
 * The one place that decides whether heavy work may start. The CPUs and memory the Docker daemon has, less the reserve
 * of the server and the dashboard, are shared by all runs through one first-come-first-served queue. Without an answer
 * from docker there is no limit.
 */
export class MachineBudget {
  private limit: Promise<Limit | null> | null = null;
  private known: Limit | null = null;
  private readonly running = new Set<Entry>();
  private readonly queue: Entry[] = [];

  constructor(
    private readonly docker: DockerRunner,
    private readonly reserve: Reserve,
  ) {}

  /** Resolves with a release when the work may start. `onWait` hears why it waits, and again when what runs changes. */
  async acquire(work: HeavyWork, footprint: Footprint, onWait?: (reason: string) => void): Promise<() => void> {
    const limit = await this.readLimit();
    if (!limit) {
      return () => undefined;
    }
    const exclusive = work.alone === true || footprint.cpus > limit.cpus || footprint.memoryBytes > limit.memoryBytes;
    return new Promise((resolve, reject) => {
      const entry: Entry = {
        work,
        footprint,
        exclusive,
        onWait,
        told: null,
        cancel: reject,
        start: () => {
          this.running.add(entry);
          resolve(() => this.release(entry));
        },
      };
      this.queue.push(entry);
      this.pump(limit);
    });
  }

  /** Drops the launches of a run that wait in the queue, so a Stop is not followed by a container. They fail with the reason. */
  cancelWaiting(runKey: string): void {
    for (const entry of this.queue.filter((item) => item.work.runKey === runKey)) {
      this.queue.splice(this.queue.indexOf(entry), 1);
      entry.cancel(new SwarmloopError(`the launch of ${entry.work.label} was dropped: the run was stopped`));
    }
    if (this.known) {
      this.pump(this.known);
    }
  }

  snapshot(): MachineLoad {
    const used = [...this.running];
    return {
      capacityCpus: this.known?.cpus ?? 0,
      capacityMemoryBytes: this.known?.memoryBytes ?? 0,
      usedCpus: used.reduce((sum, entry) => sum + entry.footprint.cpus, 0),
      usedMemoryBytes: used.reduce((sum, entry) => sum + entry.footprint.memoryBytes, 0),
      running: used.map((entry) => entry.work.label),
      waiting: this.queue.map((entry) => entry.work.label),
    };
  }

  private release(entry: Entry): void {
    if (this.running.delete(entry) && this.known) {
      this.pump(this.known);
    }
  }

  private readLimit(): Promise<Limit | null> {
    this.limit ??= this.read().then((limit) => {
      this.known = limit;
      return limit;
    });
    return this.limit;
  }

  private async read(): Promise<Limit | null> {
    try {
      const [cpus, memory] = (await this.docker(['info', '--format', '{{.NCPU}} {{.MemTotal}}'])).trim().split(/\s+/);
      const total = { cpus: Number(cpus), memoryBytes: Number(memory) };
      if (!(total.cpus > 0) || !(total.memoryBytes > 0) || !Number.isFinite(total.cpus + total.memoryBytes)) {
        return null;
      }
      return {
        cpus: Math.max(0, total.cpus - this.reserve.cpus),
        memoryBytes: Math.max(0, total.memoryBytes - this.reserve.memoryBytes),
      };
    } catch {
      return null;
    }
  }

  /** Starts work from the head of the queue while it fits. The head blocks the rest, so nobody is passed. */
  private pump(limit: Limit): void {
    while (this.queue[0] && this.fits(this.queue[0], limit)) {
      this.queue.shift()?.start();
    }
    const reason = `waiting for machine resources: ${[...this.running].map((entry) => entry.work.label).join(', ')}`;
    for (const entry of this.queue) {
      if (entry.told !== reason) {
        entry.told = reason;
        entry.onWait?.(reason);
      }
    }
  }

  private fits(entry: Entry, limit: Limit): boolean {
    const running = [...this.running];
    if (running.length === 0) {
      return true;
    }
    if (entry.exclusive || running.some((other) => other.exclusive)) {
      return false;
    }
    const cpus = running.reduce((sum, other) => sum + other.footprint.cpus, entry.footprint.cpus);
    const memory = running.reduce((sum, other) => sum + other.footprint.memoryBytes, entry.footprint.memoryBytes);
    return cpus <= limit.cpus && memory <= limit.memoryBytes;
  }
}
