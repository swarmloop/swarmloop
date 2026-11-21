import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { LiveHub } from '../live/live.hub';
import { RunEntity } from './run.entity';

/** Writes the state columns the refresh derived from the facts of a run. */
@Injectable()
export class RunFactsRepository {
  constructor(
    @InjectRepository(RunEntity) private readonly runs: Repository<RunEntity>,
    @Optional() private readonly live?: LiveHub,
  ) {}

  /**
   * Stores `columns` on the row `seen` was read from, only while its revision and status are still the ones read and
   * only when they differ from the row's. Revision and update time stay, so the write is no change of the run.
   * Tells the dashboard when a row was written; true then.
   */
  async recordFacts(
    seen: Pick<RunEntity, 'id' | 'key' | 'revision' | 'status' | 'state' | 'stateReason'>,
    columns: Pick<RunEntity, 'state' | 'stateReason'>,
  ): Promise<boolean> {
    if (seen.state === columns.state && seen.stateReason === columns.stateReason) return false;
    const written = await this.runs
      .createQueryBuilder()
      .update(RunEntity)
      .set({ ...columns })
      .where('id = :id AND revision = :revision AND status = :status', {
        id: seen.id,
        revision: seen.revision,
        status: seen.status,
      })
      .execute();
    if (!written.affected) return false;
    this.live?.changed(seen.key);
    return true;
  }
}
