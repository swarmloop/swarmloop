import { existsSync } from 'fs';
import { lstat, readdir } from 'fs/promises';
import { join } from 'path';
import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { ERROR_CODES } from '../contract/error-codes';
import { freeBytes } from '../core/free-bytes';
import { SwarmloopError } from '../core/swarmloop-error';
import type { RunEntity } from '../history/entities';
import { root } from '../history/run-paths';
import { SandboxService } from '../sandbox/sandbox.service';
import { RunRetention } from './run-retention';

const GB = 1024 ** 3;

type FreeBytes = (path: string) => Promise<number>;

/** Keeps a step from starting on a disk that it may fill: old runs go first, then Docker's leftovers, then the run blocks. */
@Injectable()
export class DiskGuard {
  private free: FreeBytes = freeBytes;

  constructor(
    private readonly config: AppConfig,
    private readonly retention: RunRetention,
    private readonly sandbox: SandboxService,
  ) {}

  /** Replaces the disk reading, for specs. */
  useFreeBytes(free: FreeBytes): void {
    this.free = free;
  }

  /** Removes dangling images and old build cache, when `DOCKER_PRUNE` is on. */
  async pruneDocker(): Promise<void> {
    if (this.config.env.DOCKER_PRUNE) {
      await this.sandbox.pruneDocker();
    }
  }

  /** Throws `DISK_LOW` when the free space stays under `MIN_FREE_GB` after the cleanup. `run` itself is never cleaned. */
  async check(run: RunEntity, step: string): Promise<void> {
    const env = this.config.env;
    const minimum = env.MIN_FREE_GB * GB;
    if (!(await this.lowerThan(minimum))) {
      return;
    }
    // RETAIN_DONE_DAYS=0 keeps everything, also when the disk runs low. Otherwise one more run goes per pass.
    while (
      env.RETAIN_DONE_DAYS > 0 &&
      (await this.lowerThan(minimum)) &&
      (await this.retention.cleanOldest(run.key)) !== null
    ) {
      // The oldest done run is cleaned first, down to a day old.
    }
    if (await this.lowerThan(minimum)) {
      await this.pruneDocker();
    }
    const free = await this.smallestFree();
    if (free < minimum) {
      throw new SwarmloopError(await this.message(run.key, step, free), { code: ERROR_CODES.DISK_LOW });
    }
  }

  private async lowerThan(minimum: number): Promise<boolean> {
    return (await this.smallestFree()) < minimum;
  }

  /** The free space of the emptier of the volumes of `data/` and `worktrees/`. */
  async smallestFree(): Promise<number> {
    const base = root(this.config);
    const readings = [];
    for (const name of ['data', 'worktrees']) {
      readings.push(await this.free(existsSync(join(base, name)) ? join(base, name) : base));
    }
    return Math.min(...readings);
  }

  private async message(key: string, step: string, free: number): Promise<string> {
    const base = root(this.config);
    const data = join(base, 'data');
    const outputNames = (await readdir(data).catch(() => [])).filter((name) => name.endsWith('-output.txt'));
    const outputs = await total(outputNames.map((name) => join(data, name)));
    const docker = (await this.sandbox.dockerUsage()).split('\n').join('; ');
    return [
      `${key} is blocked: ${(free / GB).toFixed(1)} GB of disk is free, below MIN_FREE_GB=${this.config.env.MIN_FREE_GB}. ${step} was not started.`,
      `What takes the space: agent-state ${gb(await treeBytes(join(data, 'agent-state')))}, worktrees ${gb(await treeBytes(join(base, 'worktrees')))}, outputs ${gb(outputs)}, docker: ${docker}.`,
      'Free some space, then Resume.',
    ].join('\n');
  }
}

function gb(bytes: number): string {
  return `${(bytes / GB).toFixed(1)} GB`;
}

/** The bytes of a file or of everything under a directory. An entry that vanishes while it is read counts as zero. */
export async function treeBytes(path: string): Promise<number> {
  try {
    const stats = await lstat(path);
    if (!stats.isDirectory()) {
      return stats.size;
    }
    return total((await readdir(path)).map((name) => join(path, name)));
  } catch {
    return 0;
  }
}

export async function total(paths: string[]): Promise<number> {
  let sum = 0;
  for (const path of paths) {
    sum += await treeBytes(path);
  }
  return sum;
}
