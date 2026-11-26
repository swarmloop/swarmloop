import { Injectable, Logger } from '@nestjs/common';
import { BacklogChatRepository } from '../../../history/backlog-chat.repository';

/** The take window of one running turn: its key, the takes chained so far, and what to do after each. */
interface Window {
  turnKey: string;
  pending: Promise<void>;
  onTaken: () => Promise<void>;
}

/**
 * The messages and events that come for a backlog while its turn runs. From the moment a turn opens its window until
 * its follow-up is sent, each take goes through the repository's one `takeInto`, one after another. A window is closed
 * before the turn waits, fails or ends, so a turn that waits or has failed takes nothing new.
 */
@Injectable()
export class TurnTakes {
  private readonly logger = new Logger(TurnTakes.name);
  private readonly windows = new Map<number, Window>();
  /** Every take chained and not yet finished, so a close of the module can wait for them. */
  private readonly chained = new Set<Promise<void>>();

  constructor(private readonly chat: BacklogChatRepository) {}

  /** Opens the window of the backlog's running turn. `onTaken` runs after each take. */
  open(backlogId: number, turnKey: string, onTaken: () => Promise<void>): void {
    this.windows.set(backlogId, { turnKey, pending: Promise.resolve(), onTaken });
  }

  /** Takes what waits into the backlog's running turn; false and nothing taken when no window is open. */
  take(backlogId: number): boolean {
    const window = this.windows.get(backlogId);
    if (!window) return false;
    const next = window.pending.then(async () => {
      try {
        await this.chat.takeInto(backlogId, window.turnKey);
        await window.onTaken();
      } catch (error) {
        this.logger.warn(
          `turn ${window.turnKey}: a take failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    });
    window.pending = next;
    this.chained.add(next);
    void next.finally(() => this.chained.delete(next));
    return true;
  }

  /** Closes the window of the turn, so later takes return false, and waits for the takes already chained. */
  async close(turnKey: string): Promise<void> {
    for (const [backlogId, window] of this.windows) {
      if (window.turnKey !== turnKey) continue;
      this.windows.delete(backlogId);
      await window.pending;
    }
  }

  /** Resolves when no chained take is left. */
  async idle(): Promise<void> {
    while (this.chained.size > 0) await Promise.all([...this.chained]);
  }
}
