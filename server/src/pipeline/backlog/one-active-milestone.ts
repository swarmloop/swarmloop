import { Injectable, Logger } from '@nestjs/common';
import { BacklogRepository } from '../../history/backlog.repository';
import { repairActiveMilestones } from './backlog-rules';

type Backlog = Awaited<ReturnType<BacklogRepository['listBacklogs']>>[number];

/** Keeps one active milestone in a backlog: of several, the lowest-numbered stays and the later ones queue behind the queue, in number order. */
@Injectable()
export class OneActiveMilestone {
  private readonly logger = new Logger(OneActiveMilestone.name);

  constructor(private readonly backlogs: BacklogRepository) {}

  async run(backlogs: Backlog[]): Promise<void> {
    for (const backlog of backlogs) {
      const milestones = await this.backlogs.milestones(backlog.id as number);
      const queueable = milestones.map((milestone) => ({ ...milestone, id: milestone.id as number }));
      const moves = repairActiveMilestones(queueable);
      if (moves.length === 0) continue;
      await this.backlogs.transaction(async (writers) => {
        for (const move of moves) {
          const milestone = milestones.find((other) => other.id === move.id) as (typeof milestones)[number];
          await writers.saveMilestone({ ...milestone, status: move.status, queuedAfterId: move.queuedAfterId });
        }
      });
      const numbers = moves.map((move) => `M${queueable.find((other) => other.id === move.id)?.number}`);
      this.logger.log(`backlog ${backlog.name} had more than one active milestone; queued ${numbers.join(', ')}`);
    }
  }
}
