import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { VisitStartEntity } from './visit-start.entity';

/** A start to note. A start that is a hop's visit and has no stored visit yet leaves `outside` and `statId` out. */
export type VisitStartDraft = Omit<VisitStartEntity, 'id' | 'outside' | 'statId'> &
  Partial<Pick<VisitStartEntity, 'outside' | 'statId'>>;

/** How each agent visit was started. Records are only added. */
@Injectable()
export class VisitStartRepository {
  constructor(@InjectRepository(VisitStartEntity) private readonly rows: Repository<VisitStartEntity>) {}

  async note(start: VisitStartDraft): Promise<void> {
    await this.rows.insert(start);
  }

  /** Links the start of an attempt to the stored visit it led to. */
  async link(attemptId: string, statId: number): Promise<void> {
    await this.rows.update({ attemptId }, { statId });
  }

  /** Whether an attempt has a start row. */
  async has(attemptId: string): Promise<boolean> {
    return this.rows.exists({ where: { attemptId } });
  }

  /** The run's starts in the order they were noted. */
  async forRun(runId: number): Promise<VisitStartEntity[]> {
    return this.rows.find({ where: { runId }, order: { id: 'ASC' } });
  }
}
