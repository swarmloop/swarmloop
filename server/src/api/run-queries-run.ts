import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { RunEntity } from '../history/entities';
import type { RunRepository } from '../history/run.repository';

export async function requireRun(runs: RunRepository, key: string): Promise<RunEntity> {
  const run = await runs.findRun(key);
  if (!run) {
    throw new NotFoundException(`${key} is missing`);
  }
  return run;
}

function count(value: string | undefined, name: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new BadRequestException(`${name} is not a count`);
  }
  return parsed;
}

/** The paging of the events route, from its query strings. */
export function eventPaging(query: { step?: string; after?: string; limit?: string }): {
  step?: string;
  after?: number;
  limit?: number;
} {
  return { step: query.step, after: count(query.after, 'after'), limit: count(query.limit, 'limit') };
}
