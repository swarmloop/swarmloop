import { NotFoundException } from '@nestjs/common';
import type { RunEntity } from '../history/entities';
import type { RunRepository } from '../history/run.repository';

export async function requireRun(runs: RunRepository, key: string): Promise<RunEntity> {
  const run = await runs.findRun(key);
  if (!run) {
    throw new NotFoundException(`${key} is missing`);
  }
  return run;
}
