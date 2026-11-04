import { isAbsolute, resolve } from 'path';

export interface Session {
  id: string;
  cwd: string;
  folders: string[];
  mcpServers: unknown;
  runKey: string | null;
  cancelled: boolean;
}

export interface SessionStoreOptions {
  cwd?: string;
  now: () => number;
}

export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private serial = 0;

  constructor(private readonly options: SessionStoreOptions) {}

  open(params: Record<string, unknown>): Session {
    const id = `sloop-${this.options.now().toString(36)}-${this.serial}`;
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

  restore(params: Record<string, unknown>): Session {
    const id = stringOf(params.sessionId);
    if (!id) {
      throw new Error('session is missing');
    }
    const session = this.sessions.get(id) ?? {
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

  find(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  close(id: string): void {
    this.sessions.delete(id);
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

  directory(value: string | undefined): string {
    const base = this.options.cwd ?? process.cwd();
    const cwd = value && value.trim().length > 0 ? value.trim() : base;
    return isAbsolute(cwd) ? cwd : resolve(base, cwd);
  }
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
