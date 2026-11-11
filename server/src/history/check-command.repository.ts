import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { CheckCommandEntity } from './entities';

type CheckCommandDraft = Pick<CheckCommandEntity, 'runId' | 'attemptId' | 'repo' | 'command' | 'commandIndex'> &
  Partial<Pick<CheckCommandEntity, 'status' | 'skipped' | 'startedAt' | 'endedAt' | 'exitCode'>>;

/** The commands of the checks visits of a run, one row each. */
@Injectable()
export class CheckCommandRepository {
  constructor(@InjectRepository(CheckCommandEntity) private readonly rows: Repository<CheckCommandEntity>) {}

  add(draft: CheckCommandDraft): Promise<CheckCommandEntity> {
    return this.rows.save(
      this.rows.create({ status: 'waiting', skipped: 0, startedAt: null, endedAt: null, exitCode: null, ...draft }),
    );
  }

  save(row: CheckCommandEntity): Promise<CheckCommandEntity> {
    return this.rows.save(row);
  }

  list(runId: number): Promise<CheckCommandEntity[]> {
    return this.rows.find({ where: { runId }, order: { id: 'ASC' } });
  }
}
