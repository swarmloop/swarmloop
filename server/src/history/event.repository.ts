import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Clock } from '../core/clock';
import { LoopEventEntity, HttpCallEntity } from './entities';
import type { RunEntity } from './entities';

@Injectable()
export class EventRepository {
  constructor(
    private readonly clock: Clock,
    @InjectRepository(LoopEventEntity) private readonly loops: Repository<LoopEventEntity>,
    @InjectRepository(HttpCallEntity) private readonly httpCalls: Repository<HttpCallEntity>,
  ) {}

  async recordLoop(run: RunEntity, counter: string, attempt: number, reason: string, detail?: object): Promise<void> {
    await this.loops.save(
      this.loops.create({
        runId: run.id,
        counter,
        attempt,
        reason,
        detail: detail ? JSON.stringify(detail) : null,
        createdAt: this.clock.iso(),
      }),
    );
  }

  async listLoops(runId: number): Promise<LoopEventEntity[]> {
    return this.loops.find({ where: { runId }, order: { id: 'ASC' } });
  }

  async listHttpCalls(runId: number): Promise<HttpCallEntity[]> {
    return this.httpCalls.find({ where: { runId }, order: { id: 'ASC' } });
  }
}
