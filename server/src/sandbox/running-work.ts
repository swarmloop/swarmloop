import { Injectable } from '@nestjs/common';

type WorkKind = 'agent' | 'check' | 'setup';

/** What runs now: the containers by kind and the sum of their last samples. */
interface WorkLoad {
  agents: number;
  checks: number;
  setups: number;
  cpuPercent: number;
  memoryBytes: number;
}

interface Held {
  kind: WorkKind;
  cpuPercent: number;
  rssBytes: number;
}

/** The sandbox containers that run for work, each with its last sample. */
@Injectable()
export class RunningWork {
  private readonly held = new Map<string, Held>();

  start(containerName: string, kind: WorkKind): void {
    this.held.set(containerName, { kind, cpuPercent: 0, rssBytes: 0 });
  }

  sample(containerName: string, sample: { cpuPercent: number; rssBytes: number }): void {
    const entry = this.held.get(containerName);
    if (entry) {
      entry.cpuPercent = sample.cpuPercent;
      entry.rssBytes = sample.rssBytes;
    }
  }

  end(containerName: string): void {
    this.held.delete(containerName);
  }

  load(): WorkLoad {
    const load: WorkLoad = { agents: 0, checks: 0, setups: 0, cpuPercent: 0, memoryBytes: 0 };
    for (const entry of this.held.values()) {
      if (entry.kind === 'agent') {
        load.agents += 1;
      } else if (entry.kind === 'check') {
        load.checks += 1;
      } else {
        load.setups += 1;
      }
      load.cpuPercent += entry.cpuPercent;
      load.memoryBytes += entry.rssBytes;
    }
    return load;
  }
}
