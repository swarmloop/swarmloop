import { createHash } from 'node:crypto';
import { NotFoundException } from '@nestjs/common';
import type { Server, Socket } from 'socket.io';
import type { FlowView } from '../contract/api';
import type { ClientToServerEvents, LiveRunUsage, ServerToClientEvents } from '../contract/live';
import type { RunQueriesService } from './run-queries.service';
import { TASK_SECTION_KEYS, type TaskSection } from './run-queries-tasks';

type LiveServer = Server<ClientToServerEvents, ServerToClientEvents>;
type LiveClient = Socket<ClientToServerEvents, ServerToClientEvents>;

/** The numbers of a run that a `usage` entry carries and the page shows in its metrics. */
type Figures = Pick<LiveRunUsage, 'tokens' | 'usd' | 'cpuPeak' | 'memPeak'>;

export function room(key: string): string {
  return `run:${key}`;
}

/** The run pages last sent to the rooms, so a page goes out only when it differs from the one the room has. */
export class LiveFlowRooms {
  private readonly sent = new Map<string, { hash: string; view: FlowView }>();

  constructor(
    private readonly runs: RunQueriesService,
    private readonly server: () => LiveServer,
  ) {}

  has(key: string): boolean {
    return this.sent.has(key);
  }

  clear(): void {
    this.sent.clear();
  }

  /** Forgets the pages of rooms that no socket is in any more. */
  prune(): void {
    const rooms = this.server().sockets.adapter.rooms;
    for (const key of this.sent.keys()) {
      if (!rooms.has(room(key))) {
        this.sent.delete(key);
      }
    }
  }

  /** Sends the page of a run to the room that has just joined it: to the room when it changed, else to the joiner alone. */
  async watch(client: LiveClient, key: string): Promise<void> {
    const view = await this.flowOf(key);
    if (!view) {
      return;
    }
    if (this.record(key, view)) {
      this.server().to(room(key)).emit('flow', view);
    } else {
      client.emit('flow', view);
    }
  }

  /** Builds the page of a run and sends it to its room when it differs from the last one sent. */
  async publish(key: string): Promise<void> {
    const view = await this.flowOf(key);
    if (view) {
      this.send(key, view);
    }
  }

  /** Lays the task section and the figures of a run over the last page its room got, and sends that page when it differs. */
  async publishTasks(key: string, figures: Figures): Promise<void> {
    const last = this.sent.get(key)?.view;
    if (!last) {
      return;
    }
    const section = await this.tasksOf(key);
    if (!section) {
      return;
    }
    const view: FlowView = { ...last, metrics: { ...last.metrics, ...figures } };
    const absent: Partial<Record<(typeof TASK_SECTION_KEYS)[number], unknown>> = view;
    for (const name of TASK_SECTION_KEYS) {
      if (!(name in section)) {
        delete absent[name];
      }
    }
    this.send(key, { ...view, ...section });
  }

  send(key: string, view: FlowView): void {
    if (this.record(key, view)) {
      this.server().to(room(key)).emit('flow', view);
    }
  }

  /** Records the page as the room's last; false when the room already has exactly this page. */
  private record(key: string, view: FlowView): boolean {
    const hash = createHash('sha256').update(JSON.stringify(view)).digest('hex');
    if (this.sent.get(key)?.hash === hash) {
      return false;
    }
    this.sent.set(key, { hash, view });
    return true;
  }

  private flowOf(key: string): Promise<FlowView | null> {
    return unlessMissing(() => this.runs.flow(key));
  }

  private tasksOf(key: string): Promise<TaskSection | null> {
    return unlessMissing(() => this.runs.tasks(key));
  }
}

/** A run that is gone gives nothing, so a publish never throws for it. */
async function unlessMissing<T>(read: () => Promise<T>): Promise<T | null> {
  try {
    return await read();
  } catch (error) {
    if (error instanceof NotFoundException) {
      return null;
    }
    throw error;
  }
}
