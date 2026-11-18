import { Injectable, Logger } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';

const CHECKPOINT_MS = 60_000;

/**
 * Copies the WAL into the database file at quiet moments. A passive checkpoint copies what it can without
 * waiting for a writer or a reader, so no commit pays for it. The API process schedules it (api-main.ts).
 */
@Injectable()
export class WalCheckpoint implements OnModuleDestroy {
  private readonly logger = new Logger(WalCheckpoint.name);
  private timer: NodeJS.Timeout | null = null;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  schedule(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => void this.checkpoint(), CHECKPOINT_MS);
    this.timer.unref();
  }

  /** Only a server that scheduled the timer checkpoints when it stops. */
  async onModuleDestroy(): Promise<void> {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    await this.checkpoint();
  }

  private async checkpoint(): Promise<void> {
    try {
      await this.dataSource.query('PRAGMA wal_checkpoint(PASSIVE)');
    } catch (error) {
      this.logger.warn(`WAL checkpoint failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
