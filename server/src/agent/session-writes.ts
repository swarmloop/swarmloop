import { writeSession } from './agent-session';
import type { RuntimeName } from '../integrations/agent-runtime/agent-runtime.registry';
import type { SessionState } from './limits';

/** The session file writes of one launch: one after another, so the last write is the last state. Without a file, none. */
export class SessionWrites {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string | null,
    private readonly runtime: RuntimeName,
  ) {}

  /** Queues an intermediate state. A failure is caught so later writes still run. */
  queue(state: SessionState): void {
    this.chain = this.chain.then(() => this.save(state)).catch(() => undefined);
  }

  /** Writes the final state after every queued write; its own failure rejects. */
  write(state: SessionState): Promise<void> {
    const written = this.chain.then(() => this.save(state));
    this.chain = written.catch(() => undefined);
    return written;
  }

  /** Resolves when no write is running. */
  async settled(): Promise<void> {
    await this.chain;
  }

  private async save(state: SessionState): Promise<void> {
    if (this.file !== null) {
      await writeSession(this.file, this.runtime, state);
    }
  }
}
