import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, IsNull, Repository } from 'typeorm';
import { CheckCommandEntity } from './entities';

type CheckCommandDraft = Pick<CheckCommandEntity, 'runId' | 'attemptId' | 'repo' | 'command' | 'commandIndex'> &
  Partial<Pick<CheckCommandEntity, 'name' | 'status' | 'skipped' | 'startedAt' | 'endedAt' | 'exitCode'>>;

/** The commands of the checks visits of a run, one row each. */
@Injectable()
export class CheckCommandRepository {
  constructor(@InjectRepository(CheckCommandEntity) private readonly rows: Repository<CheckCommandEntity>) {}

  add(draft: CheckCommandDraft): Promise<CheckCommandEntity> {
    return this.rows.save(
      this.rows.create({
        name: null,
        status: 'waiting',
        skipped: 0,
        startedAt: null,
        endedAt: null,
        exitCode: null,
        ...draft,
      }),
    );
  }

  save(row: CheckCommandEntity): Promise<CheckCommandEntity> {
    return this.rows.save(row);
  }

  /** Ends the rows of an attempt that never finished, as interrupted. A row that has an end is left as it is. */
  async closeOpen(attemptId: string, endedAt: string): Promise<void> {
    await this.rows.update(
      { attemptId, status: In(['waiting', 'running']), endedAt: IsNull() },
      { status: 'interrupted', exitCode: null, endedAt },
    );
  }

  list(runId: number): Promise<CheckCommandEntity[]> {
    return this.rows.find({ where: { runId }, order: { id: 'ASC' } });
  }
}
