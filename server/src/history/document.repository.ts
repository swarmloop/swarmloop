import { Injectable, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Clock } from '../core/clock';
import { LiveHub } from '../live/live.hub';
import { RunEntity, DocumentEntity } from './entities';

@Injectable()
export class DocumentRepository {
  constructor(
    private readonly clock: Clock,
    @InjectRepository(RunEntity) private readonly runs: Repository<RunEntity>,
    @InjectRepository(DocumentEntity) private readonly documents: Repository<DocumentEntity>,
    @Optional() private readonly live?: LiveHub,
  ) {}

  async putDocument(run: RunEntity, kind: string, body: string): Promise<void> {
    const latest = await this.documents.findOne({
      where: { runId: run.id, kind },
      order: { id: 'DESC' },
    });
    if (latest?.body === body) {
      return;
    }
    await this.documents.save(
      this.documents.create({
        runId: run.id,
        stepStatId: 0,
        kind,
        attempt: 0,
        body,
        path: '',
        createdAt: this.clock.iso(),
      }),
    );
    this.live?.changed(run.key);
  }

  async latestBody(key: string, kind: string): Promise<string | null> {
    return (await this.latestDocument(key, kind))?.body ?? null;
  }

  async latestDocument(key: string, kind: string): Promise<{ id: number; body: string } | null> {
    const run = await this.runs.findOne({ where: { key } });
    if (!run) {
      return null;
    }
    const found = await this.documents.findOne({
      where: { runId: run.id, kind },
      order: { id: 'DESC' },
    });
    return found ? { id: found.id, body: found.body } : null;
  }

  /** The id of the latest document of each kind that the run has. */
  async latestIds(runId: number, kinds: string[]): Promise<Map<string, number>> {
    if (kinds.length === 0) {
      return new Map();
    }
    const found: { kind: string; id: number }[] = await this.documents
      .createQueryBuilder('document')
      .select('document.kind', 'kind')
      .addSelect('MAX(document.id)', 'id')
      .where('document.runId = :runId AND document.kind IN (:...kinds)', { runId, kinds })
      .groupBy('document.kind')
      .getRawMany();
    return new Map(found.map(({ kind, id }) => [kind, Number(id)]));
  }

  async hasDocument(key: string, kind: string): Promise<boolean> {
    const run = await this.runs.findOne({ where: { key } });
    if (!run) {
      return false;
    }
    const found = await this.documents.findOne({ where: { runId: run.id, kind } });
    return found !== null;
  }

  async listDocuments(runId: number): Promise<DocumentEntity[]> {
    return this.documents.find({ where: { runId }, order: { id: 'ASC' } });
  }
}
