import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { FootprintPeak, FootprintSource, HeavyKind } from '../core/heavy-work';
import { ResourceSampleEntity } from './entities';

/** How many finished pieces of work a footprint is learned from. */
const PIECES = 50;

interface PeakRow {
  cpuPercent: number | string | null;
  rssBytes: number | string | null;
}

/** The peak CPU and memory of the last finished pieces of work of one kind, read from the resource samples. */
@Injectable()
export class FootprintRepository implements FootprintSource {
  constructor(@InjectRepository(ResourceSampleEntity) private readonly samples: Repository<ResourceSampleEntity>) {}

  async peaks(kind: HeavyKind, name: string): Promise<FootprintPeak[]> {
    const rows: PeakRow[] = await this.samples.query(...this.queryOf(kind, name));
    return rows.map((row) => ({ cpuPercent: Number(row.cpuPercent) || 0, rssBytes: Number(row.rssBytes) || 0 }));
  }

  private queryOf(kind: HeavyKind, name: string): [string, string[]] {
    if (kind === 'agent') {
      return [this.peakSql('', `s.runtime = ? AND (r.source = 'agent' OR r.source IS NULL)`), [name, name]];
    }
    if (kind === 'setup') {
      return [
        this.peakSql(
          'INNER JOIN runs u ON u.id = s.run_id',
          `r.source = 'setup' AND TRIM(u.projects, char(10, 13, 32)) = ?`,
        ),
        [name, name],
      ];
    }
    return [
      this.peakSql(
        'INNER JOIN check_commands c ON c.attempt_id = s.attempt_id',
        `r.source GLOB '[0-9]*' AND r.source NOT GLOB '*[^0-9]*'
         AND c.command_index = CAST(r.source AS INTEGER) AND COALESCE(c.name, c.command) = ?`,
      ),
      [name, name],
    ];
  }

  /**
   * The newest visits that hold such a piece are picked first, walking `step_stats` from the newest and probing the
   * samples by their index, so the read never grows with the whole history of samples.
   */
  private peakSql(join: string, where: string): string {
    return `SELECT MAX(r.cpu_percent) AS cpuPercent, MAX(r.rss_bytes) AS rssBytes
       FROM resource_samples r
       INNER JOIN step_stats s ON s.id = r.step_stat_id
       ${join}
       WHERE r.step_stat_id IN (
         SELECT s.id FROM step_stats s
         WHERE EXISTS (SELECT 1 FROM resource_samples r ${join} WHERE r.step_stat_id = s.id AND ${where})
         ORDER BY s.id DESC
         LIMIT ${PIECES}
       ) AND ${where}
       GROUP BY r.step_stat_id, r.source
       ORDER BY r.step_stat_id DESC, r.source
       LIMIT ${PIECES}`;
  }
}
