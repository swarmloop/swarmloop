import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VisitStartEntity } from './visit-start.entity';

export type VisitStartDraft = Omit<VisitStartEntity, 'id'>;

/** How each agent visit was started. Records are only added. */
@Injectable()
export class VisitStartRepository {
  constructor(@InjectRepository(VisitStartEntity) private readonly rows: Repository<VisitStartEntity>) {}

  async note(start: VisitStartDraft): Promise<void> {
    await this.rows.insert(start);
  }

  /** The run's starts in the order they were noted. */
  async forRun(runId: number): Promise<VisitStartEntity[]> {
    return this.rows.find({ where: { runId }, order: { id: 'ASC' } });
  }
}
