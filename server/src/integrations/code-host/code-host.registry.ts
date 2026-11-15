import type { ConnectionsService } from '../../auth/connections.service';
import { remoteProject } from './remote-project';
import { GitAuthError, SwarmloopError } from '../../core/swarmloop-error';
import type { CodeHost, SelectedHost } from './code-host';
import type { AbstractCodeHost, CodeHostEnv } from './abstract-code-host';
import type { Clock } from '../../core/clock';
import type { Connection } from '../connection';
import type { CodeHostAdapter } from './code-host-adapter';
import { codeHostAdapters } from './code-host-adapters';

interface Entry {
  readonly adapter: CodeHostAdapter;
  readonly host: AbstractCodeHost;
}

export class CodeHostRegistry {
  readonly names: readonly CodeHostName[] = codeHostAdapters().map((adapter) => adapter.name);

  private constructor(
    private readonly entries: readonly Entry[],
    private readonly connectionStore?: ConnectionsService,
  ) {}

  /**
   * The registry of one run: each host calls with the token of the person who started it. A person without a
   * connection on a host, the machine token, the CLI and nobody keep the token of the environment. A token that cannot
   * be used any more is a `GitAuthError`: the run waits for the person to reconnect.
   */
  async forRun(startedBy: string | null | undefined, codeHost?: string): Promise<CodeHostRegistry> {
    const connections = this.connectionStore;
    if (!connections || !startedBy || startedBy === 'machine') {
      return this;
    }
    // With the host known, only that host's connection counts. Without it a broken connection falls back to the env token.
    const tokenOf = (name: CodeHostName) =>
      codeHost
        ? codeHost === name
          ? connections.tokenFor(name, startedBy)
          : Promise.resolve(null)
        : connections.tokenFor(name, startedBy).catch((error: unknown) => {
            if (error instanceof GitAuthError) return null;
            throw error;
          });
    const tokens = await Promise.all(this.entries.map(({ adapter }) => tokenOf(adapter.name)));
    return new CodeHostRegistry(
      this.entries.map(({ adapter, host }, index) => {
        const token = tokens[index];
        return { adapter, host: token === null || token === undefined ? host : host.withToken(token) };
      }),
    );
  }

  /** The host of a run, with the token of its person. A host with no token or url is a refusal. */
  async hostFor(run: { codeHost: string; startedBy: string | null }): Promise<CodeHost> {
    const scoped = await this.forRun(run.startedBy, run.codeHost);
    scoped.requiredCredentials(run.codeHost);
    return scoped.byName(run.codeHost);
  }

  /** The tokens a git process of the server reads, those of the person of a run. */
  async tokensFor(startedBy: string | null | undefined, codeHost?: string): Promise<Partial<CodeHostEnv>> {
    const run = await this.forRun(startedBy, codeHost);
    return Object.fromEntries(run.entries.map(({ adapter, host }) => [adapter.tokenKey, host.selected().token]));
  }

  static create(env: CodeHostEnv, clock: Clock, connectionStore?: ConnectionsService): CodeHostRegistry {
    return new CodeHostRegistry(
      codeHostAdapters().map((adapter) => ({ adapter, host: adapter.create(env, clock) })),
      connectionStore,
    );
  }

  /** How a person connects each host; none when the store of connections is absent. */
  connections(): Connection[] {
    const store = this.connectionStore;
    return store ? this.entries.map(({ adapter, host }) => adapter.connection(host.selected(), store)) : [];
  }

  has(name: string): boolean {
    return this.entries.some(({ host }) => host.name === name);
  }

  byName(name: string): CodeHost {
    return this.take(name);
  }

  forOrigin(origin: string): CodeHostName | null {
    const matched = this.entries.map(({ host }) => host).filter((host) => host.matchesOrigin(origin));
    if (matched.length > 1) {
      throw new SwarmloopError(`${remoteProject(origin).host.toLowerCase()} matches both code hosts`);
    }
    const found = matched[0];
    return found ? (found.name as CodeHostName) : null;
  }

  credentials(name: string): SelectedHost {
    return this.take(name).selected();
  }

  requiredCredentials(name: string): SelectedHost {
    const host = this.credentials(name);
    if (!host.baseUrl.trim()) {
      throw new SwarmloopError(`${host.baseKey} is missing`);
    }
    if (!host.token.trim()) {
      throw new SwarmloopError(`${host.tokenKey} is missing`);
    }
    try {
      new URL(host.baseUrl);
    } catch {
      throw new SwarmloopError(`${host.baseKey} is not a url`);
    }
    return host;
  }

  /** The first host, in push order, that can build a push URL; the token is the one of that host. When none can, the last host's. */
  pushAuth(origin: string): { url: string | null; token: string } {
    const ordered = [...this.entries].sort((a, b) => a.adapter.pushOrder - b.adapter.pushOrder);
    for (const { host } of ordered) {
      const url = host.pushUrl(origin);
      if (url) {
        return { url, token: host.selected().token };
      }
    }
    const last = ordered[ordered.length - 1];
    return { url: null, token: last ? last.host.selected().token : '' };
  }

  private take(name: string): CodeHost {
    const host = this.entries.find((item) => item.host.name === name)?.host;
    if (!host) {
      throw new SwarmloopError('code host is missing');
    }
    return host;
  }
}

export type CodeHostName = CodeHostAdapter['name'];

/** One host for this call. An empty list leaves the stored name alone. */
export function assignCodeHost(
  run: { codeHost: string },
  hosts: readonly (CodeHostName | null)[],
  replace: boolean,
): void {
  const found = [...new Set(hosts.filter((host): host is CodeHostName => host !== null))].sort();
  if (found.length > 1) {
    throw new SwarmloopError(`origins use ${found.join(' and ')}`);
  }
  const host = found[0];
  if (!host) {
    return;
  }
  if (!replace && run.codeHost && run.codeHost !== host) {
    throw new SwarmloopError(`origin is not ${run.codeHost}`);
  }
  run.codeHost = host;
}
