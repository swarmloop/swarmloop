import { rm } from 'fs/promises';
import { Logger } from '@nestjs/common';

/** Removes the git-metadata copies of a finished container in the background, off the main thread. */
export class MetadataRemoval {
  private readonly logger = new Logger(MetadataRemoval.name);
  private readonly pending = new Set<Promise<void>>();

  /** Starts the removal of every path and returns at once. A failure is logged with its path, never thrown. */
  remove(paths: readonly string[]): void {
    for (const path of paths) {
      const removal: Promise<void> = rm(path, { recursive: true, force: true })
        .catch((error: unknown) => {
          this.logger.warn(`Could not remove ${path}: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => this.pending.delete(removal));
      this.pending.add(removal);
    }
  }

  /** Waits for every removal that is still running. */
  async drained(): Promise<void> {
    await Promise.all([...this.pending]);
  }
}
