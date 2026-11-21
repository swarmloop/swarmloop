import { BadRequestException, Controller, Get, Query } from '@nestjs/common';
import type { StatsView } from '../contract/api';
import { reviewKinds } from '../agent-result/stored-review';
import { Clock } from '../core/clock';
import { DocumentRepository } from '../history/document.repository';
import { RunRepository } from '../history/run.repository';
import { StatsRepository } from '../history/stats.repository';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { requirementBodies } from './run-view/run-title';
import { buildStats, rangeStart, type StatsRange } from './stats';
import { countedRunsOf } from './stats-units';

const MAX_DAYS = 3650;
const MAX_TZ_OFFSET = 14 * 60;

function integer(value: string | undefined, fallback: number, min: number, max: number, name: string): number {
  if (value === undefined || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new BadRequestException(`${name} must be a whole number from ${min} to ${max}`);
  }
  return parsed;
}

@Controller('stats')
export class StatsController {
  constructor(
    private readonly stats: StatsRepository,
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly clock: Clock,
  ) {}

  /** `days`: the last N local days, 0 for every run (default 30). `tz`: the viewer's `getTimezoneOffset()`. */
  @Get()
  async report(@Query('days') days?: string, @Query('tz') tz?: string): Promise<StatsView> {
    const range: StatsRange = {
      days: integer(days, 30, 0, MAX_DAYS, 'days'),
      tzOffset: integer(tz, 0, -MAX_TZ_OFFSET, MAX_TZ_OFFSET, 'tz'),
    };
    const now = this.clock.now();
    const rows = await this.stats.rows(rangeStart(now, range));
    const requirements = await requirementBodies(this.documents, rows.runs);
    // Only the runs in the range are summed, so only their steps are read.
    const durations = await this.runs.durationByRun(range.days > 0 ? rows.runs.map((run) => run.id) : undefined);
    const merged = countedRunsOf(rows.runs).filter(({ run }) => run.state === 'merged');
    const mergedDocuments = await this.documents.latestDocuments(
      merged.map(({ run }) => run.id),
      [ARTIFACTS.requirementList.kind, ...reviewKinds('requirements')],
    );
    return buildStats(rows, durations, now, range, requirements, mergedDocuments);
  }
}
