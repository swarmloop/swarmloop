import { Injectable } from '@nestjs/common';
import { join } from 'node:path';
import { chatStateRemoved, readStoredSession } from '../../agent/agent-session';
import { AppConfig } from '../../config/env';
import type { RunState } from '../../contract/run-state';
import { REVIEW_STEPS } from '../../contract/steps';
import { Clock } from '../../core/clock';
import type { AgentCallRow, PingStopReason } from '../../history/agent-call';
import { AgentCallRepository } from '../../history/agent-call.repository';
import type { RunEntity } from '../../history/entities';
import { RunRepository } from '../../history/run.repository';
import { root } from '../../history/run-paths';
import { storedState } from '../../history/run-state';
import { sessionFileName } from '../../history/session-group';
import { ContainerGate } from '../../sandbox/container-gate';
import type { PingCall } from '../../steps/shared/agent-launch-request';
import { chatCache } from '../../steps/shared/chat-cache';

const MINUTE_MS = 60_000;

/** A chat's pings start this long before its prompt cache runs out: the margin for a slow start, a tick or a restart. */
const MARGIN_MIN = 10;

/** The chats a later visit resumes: the plan chat, the implement chat and each reviewer's chat. The review report and a backlog turn always start fresh. */
const SESSION_STEPS: readonly string[] = ['plan', 'implement', ...REVIEW_STEPS];

/** A plain run or a part that has ended, so no visit comes back to its chats. */
const RUN_ENDED: readonly RunState[] = ['merged', 'done', 'failed', 'closed', 'skipped'];

/** An epic's parent still gets answers and a merge look until the epic merges or closes. */
const EPIC_ENDED: readonly RunState[] = ['merged', 'closed', 'skipped'];

/** A chat that is due for a ping: its run, its last row, and the ping to send. */
export interface DuePing {
  run: RunEntity;
  last: AgentCallRow;
  chat: PingCall;
}

/**
 * Picks the chats to keep warm. It reads each open run's session files by the launcher's resume rule and the log's
 * last row of each chat. A chat that stops being pinged gets one ping-stop row with its reason, which ends its pings
 * until its next call.
 */
@Injectable()
export class PingCandidates {
  constructor(
    private readonly runs: RunRepository,
    private readonly calls: AgentCallRepository,
    private readonly gate: ContainerGate,
    private readonly clock: Clock,
    private readonly config: AppConfig,
  ) {}

  /** The chats due now. Nothing is due while the server is paused. */
  async pass(): Promise<DuePing[]> {
    if (this.gate.paused()) return [];
    const pinged = new Map<string, AgentCallRow[]>();
    for (const row of await this.calls.chatsEndingInPing()) {
      pinged.set(row.runKey ?? '', [...(pinged.get(row.runKey ?? '') ?? []), row]);
    }
    const due: DuePing[] = [];
    for (const run of await this.runs.listRuns()) {
      const over = overOf(run);
      if (over) {
        await this.stopAll(pinged.get(run.key) ?? [], over);
        continue;
      }
      for (const chatId of await this.chatsOf(run)) {
        const ping = await this.dueOf(run, chatId);
        if (ping) due.push(ping);
      }
    }
    return due;
  }

  /** The chats a visit of the run would resume, from its session files. */
  private async chatsOf(run: RunEntity): Promise<string[]> {
    const dir = root(this.config);
    const chats = new Set<string>();
    for (const step of SESSION_STEPS) {
      const stored = await readStoredSession(join(dir, 'data', sessionFileName(run.key, step)));
      if (stored?.chatId && !chatStateRemoved(dir, run.key, step, stored)) chats.add(stored.chatId);
    }
    return [...chats];
  }

  /** The ping a chat is due for now, or null; a chat whose pings end gets its stop row. */
  private async dueOf(run: RunEntity, chatId: string): Promise<DuePing | null> {
    const last = await this.calls.lastRowOfChat(chatId);
    if (!last || last.kind === 'ping-stop' || last.endKind === 'running') return null;
    if (last.kind === 'ping' && last.endKind !== 'done') return this.stop(last, 'ping-failed');
    const cache = chatCache(last.runtime, last.model);
    if (!cache) return null;
    if (last.kind === 'ping' && (await this.calls.pingsSinceCall(chatId)) >= cache.maxPings) {
      return this.stop(last, 'cap-reached');
    }
    const dueMs = Date.parse(last.finishedAt || last.startedAt) + (cache.ttlMinutes - MARGIN_MIN) * MINUTE_MS;
    if (this.clock.now() < dueMs) return null;
    return { run, last, chat: { chatId, dueAt: new Date(dueMs).toISOString(), previousId: last.id } };
  }

  private async stopAll(rows: AgentCallRow[], reason: PingStopReason): Promise<void> {
    for (const row of rows) {
      if (row.endKind !== 'running') await this.stop(row, reason);
    }
  }

  private async stop(last: AgentCallRow, reason: PingStopReason): Promise<null> {
    if (last.chatId) await this.calls.addStop(last.chatId, reason, this.clock.iso());
    return null;
  }
}

/** Why a run's chats are not pinged, or null while a visit may still come back to them. A run that is over gains no more rows. */
export function overOf(run: RunEntity): PingStopReason | null {
  const { state } = storedState(run);
  if (state === 'stopped') return 'person-stopped';
  const epic = run.parentRunId === null && run.epicAt !== null;
  if (epic) return EPIC_ENDED.includes(state) ? 'epic-merged' : null;
  return RUN_ENDED.includes(state) ? 'run-closed' : null;
}
