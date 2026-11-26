import type { OnModuleDestroy } from '@nestjs/common';
import { Injectable, Logger } from '@nestjs/common';
import { AppConfig } from '../../config/env';
import { markedInterval } from '../../core/entered-marks';
import { DocumentRepository } from '../../history/document.repository';
import { AgentDoor } from '../../steps/shared/agent-door';
import { PingCandidates } from './ping-candidates';
import { pingRequest } from './ping-request';

/** How often a pass looks for chats that are due. A chat is pinged 10 minutes before its cache runs out, so a minute is fine grain. */
const PASS_MS = 60_000;

/**
 * Keeps each resumable chat in the model's prompt cache while its run can still come back to it. One service for every
 * level of run. It reaches the agent only through the door, has no retry of its own and changes no run: a ping that
 * fails is a row of the log, and the chat's pings end there.
 */
@Injectable()
export class KeepWarm implements OnModuleDestroy {
  private readonly logger = new Logger(KeepWarm.name);
  private timer: NodeJS.Timeout | null = null;
  /** The pass in flight. A tick that finds it set does not start another. */
  private pass: Promise<void> | null = null;

  constructor(
    private readonly door: AgentDoor,
    private readonly candidates: PingCandidates,
    private readonly documents: DocumentRepository,
    private readonly config: AppConfig,
  ) {}

  /**
   * Starts the timer. Only the API server calls it: a CLI process boots the same modules while the server's pings run.
   * The pings a dead process left open are closed first.
   */
  async schedule(): Promise<void> {
    this.stop();
    await this.door.closeOpenPings();
    this.timer = markedInterval('keep-warm pass', () => this.tick(), PASS_MS);
  }

  /** Stops the timer and waits for the pass that runs, so nothing reads the database after it closes. */
  async onModuleDestroy(): Promise<void> {
    this.stop();
    await this.pass;
  }

  /** One pass: every chat that is due gets its ping, one after another. */
  private async runPass(): Promise<void> {
    for (const due of await this.candidates.pass()) {
      try {
        const request = await pingRequest({ config: this.config, documents: this.documents }, due);
        if (request) await this.door.ping(due.chat, request);
      } catch (error) {
        this.logger.warn(`ping of ${due.run.key} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  private stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (this.pass) return;
    this.pass = this.runPass()
      .catch((error: unknown) => {
        this.logger.warn(`keep-warm pass failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.pass = null;
      });
  }
}
