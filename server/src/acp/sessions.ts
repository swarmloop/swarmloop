import { isAbsolute, resolve } from 'path';
import type { Clock } from '../core/clock';
import type { ServerApi } from './server-api';

export interface Session {
  id: string;
  cwd: string;
  folders: string[];
  mcpServers: unknown;
  runKey: string | null;
  cancelled: boolean;
}

export interface SessionOptions {
  api: ServerApi;
  cwd?: string;
  clock: Clock;
}

export class Sessions {
  private readonly sessions = new Map<string, Session>();
  private serial = 0;

  constructor(private readonly options: SessionOptions) {}

  open(params: Record<string, unknown>): Session {
    const id = `sloop-${this.options.clock.now().toString(36)}-${this.serial}`;
    this.serial += 1;
    const session: Session = {
      id,
      cwd: this.directory(stringOf(params.cwd)),
      folders: this.rootFolders(params),
      mcpServers: params.mcpServers,
      runKey: null,
      cancelled: false,
    };
    this.sessions.set(id, session);
    return session;
  }

  resume(params: Record<string, unknown>): Session {
    const id = stringOf(params.sessionId);
    if (!id) {
      throw new Error('session is missing');
    }
    const known = this.sessions.get(id);
    const session: Session = known ?? {
      id,
      cwd: this.directory(stringOf(params.cwd)),
      folders: this.rootFolders(params),
      mcpServers: params.mcpServers,
      runKey: id.startsWith('sloop-') ? null : id,
      cancelled: false,
    };
    session.cwd = this.directory(stringOf(params.cwd) || session.cwd);
    session.folders = this.rootFolders({ ...params, cwd: session.cwd });
    if (params.mcpServers !== undefined) {
      session.mcpServers = params.mcpServers;
    }
    this.sessions.set(id, session);
    return session;
  }

  get(id: string, cwd?: string): Session {
    if (!id) {
      throw new Error('session is missing');
    }
    const existing = this.sessions.get(id);
    if (existing) {
      if (cwd) {
        existing.cwd = this.directory(cwd);
        if (!existing.folders.includes(existing.cwd)) {
          existing.folders.push(existing.cwd);
        }
      }
      return existing;
    }
    if (id.startsWith('sloop-')) {
      throw new Error('session is missing');
    }
    const created: Session = {
      id,
      cwd: this.directory(cwd),
      folders: [this.directory(cwd)],
      mcpServers: undefined,
      runKey: id,
      cancelled: false,
    };
    this.sessions.set(id, created);
    return created;
  }

  async cancel(params: unknown): Promise<void> {
    const session = this.sessions.get(stringOf(record(params).sessionId));
    if (!session) {
      return;
    }
    session.cancelled = true;
    if (!session.runKey) {
      return;
    }
    try {
      await this.options.api.stop(session.runKey);
    } catch {
      // The prompt already ends. A stop failure must not keep the turn open.
    }
  }

  close(id: string): void {
    this.sessions.delete(id);
  }

  directory(value: string | undefined): string {
    const base = this.options.cwd ?? process.cwd();
    const cwd = value && value.trim().length > 0 ? value.trim() : base;
    return isAbsolute(cwd) ? cwd : resolve(base, cwd);
  }

  private rootFolders(params: Record<string, unknown>): string[] {
    const cwd = this.directory(stringOf(params.cwd));
    const extra = Array.isArray(params.roots) ? params.roots : [];
    const paths = [
      cwd,
      ...extra
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => this.directory(item)),
    ];
    return [...new Set(paths)];
  }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
