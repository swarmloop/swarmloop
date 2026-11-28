import { Logger } from '@nestjs/common';
import type { RunEntity } from '../history/entities';
import type { DocumentRepository } from '../history/document.repository';
import { refusedAsBusy } from '../history/command.repository';
import { ARTIFACTS } from '../steps/contract/artifacts';
import type { Delivery } from '../steps/shared/subtask-ops';
import type { PartStart } from '../steps/contract/artifacts-split';

/**
 * The one way a start reaches a part from its epic. A start the door refuses as held is stored on the part and sent
 * again by the epic's next pass, so a held part is a wait of the epic and never a failure.
 */
export class PartDelivery {
  private readonly logger = new Logger(PartDelivery.name);

  constructor(private readonly documents: DocumentRepository) {}

  /** Runs `send`. A refusal as held stores `record` and answers `held`; any other error goes on. */
  async start(child: RunEntity, record: PartStart, send: () => Promise<unknown>): Promise<Delivery> {
    try {
      await send();
    } catch (error) {
      if (!refusedAsBusy(error)) throw error;
      await this.documents.putDocument(child, ARTIFACTS.partStart.kind, ARTIFACTS.partStart.format(record));
      this.logger.log(`${child.key} is held: its start ${record.key} waits for the epic's next pass`);
      return 'held';
    }
    if (await this.held(child)) await this.documents.putDocument(child, ARTIFACTS.partStart.kind, '');
    return 'sent';
  }

  /** The start of the part that waits to be sent again, or null. */
  async held(child: RunEntity): Promise<PartStart | null> {
    return ARTIFACTS.partStart.parse((await this.documents.latestBody(child.key, ARTIFACTS.partStart.kind)) ?? '');
  }
}
