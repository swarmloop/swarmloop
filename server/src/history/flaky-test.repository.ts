import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FlakyTestEntity } from './flaky-test.entity';

export type FlakyTestDraft = Omit<FlakyTestEntity, 'id'>;

/** The tests that failed and passed on the same code. Records are only added. */
@Injectable()
export class FlakyTestRepository {
  constructor(@InjectRepository(FlakyTestEntity) private readonly rows: Repository<FlakyTestEntity>) {}

  async record(draft: FlakyTestDraft): Promise<void> {
    await this.rows.insert(draft);
  }

  /** True when the test has records on two different runs (`runId` counts as one) or a record on `mainRef`. */
  async blocks(project: string, test: string, runId: string, mainRef: string): Promise<boolean> {
    const records = await this.rows.find({ select: { runId: true, ref: true }, where: { project, test } });
    const runs = new Set([runId, ...records.map((record) => record.runId)]);
    return runs.size >= 2 || records.some((record) => record.ref === mainRef);
  }
}
