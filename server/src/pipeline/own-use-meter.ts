import { readdir } from 'fs/promises';
import { join } from 'path';
import { Injectable } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { Clock } from '../core/clock';
import { root } from '../history/run-paths';
import { total, treeBytes } from './disk-guard';

/** Measures what swarmloop itself takes of the disk, one walk at a time, away from any request. */
@Injectable()
export class OwnUseMeter {
  private latest: { line: string; at: number } | null = null;
  private walking = false;

  constructor(
    private readonly config: AppConfig,
    private readonly clock: Clock,
  ) {}

  /** Walks the folders and keeps the result. Does nothing while a walk runs; a failed walk keeps the last result. */
  async measure(): Promise<void> {
    if (this.walking) {
      return;
    }
    this.walking = true;
    try {
      const line = await this.walk();
      this.latest = { line, at: this.clock.now() };
    } finally {
      this.walking = false;
    }
  }

  last(): { line: string; at: number } | null {
    return this.latest;
  }

  /** What swarmloop itself takes: worktrees, logs (output files), backups and the environment cache. */
  private async walk(): Promise<string> {
    const base = root(this.config);
    const data = join(base, 'data');
    const logs = (await readdir(data).catch(() => [])).filter((name) => /-(output|log)\.txt$/.test(name));
    const parts = [
      ['worktrees', await treeBytes(join(base, 'worktrees'))],
      ['logs', await total(logs.map((name) => join(data, name)))],
      ['backups', await treeBytes(join(data, 'backups'))],
      ['environment cache', await treeBytes(join(data, 'env-cache'))],
    ] as const;
    return `swarmloop uses ${parts.map(([name, bytes]) => `${name} ${size(bytes)}`).join(', ')}`;
  }
}

function size(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${unit === 0 ? value : value.toFixed(1)} ${units[unit]}`;
}
