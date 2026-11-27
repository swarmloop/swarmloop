import type { ConnectionsService } from '../../auth/connections.service';
import { RunHosts, type RunHostEntry } from './run-hosts';
import { GitAuthError, SwarmloopError } from '../../core/swarmloop-error';
import type { CodeHost, SelectedHost } from './code-host';
import type { CodeHostEnv } from './abstract-code-host';
import type { OnModuleDestroy, OnModuleInit, Type } from '@nestjs/common';
import type { Clock } from '../../core/clock';
import type { Connection } from '../connection';
import type { CodeHostAdapter } from './code-host-adapter';
import { codeHostAdapters } from './code-host-adapters';
import { registerSecretSource } from '../../core/secret-sources';
import type { AppFlow, AppSource, LoginProvider } from './login-provider';

export class CodeHostRegistry implements OnModuleInit, OnModuleDestroy {
  private unregisterSecrets: (() => void) | undefined;

  readonly names: readonly CodeHostName[] = codeHostAdapters().map((adapter) => adapter.name);

  private readonly envHosts: RunHosts;

  private constructor(
    private readonly entries: readonly RunHostEntry[],
    private readonly connectionStore?: ConnectionsService,
  ) {
    this.envHosts = new RunHosts(entries);
  }

  onModuleInit(): void {
    this.unregisterSecrets = registerSecretSource(() => this.entries.flatMap(({ host }) => host.secrets()));
  }

  onModuleDestroy(): void {
    this.unregisterSecrets?.();
  }

  /**
   * The hosts of one person: each host calls with the token of that person. A person without a connection on a host,
   * the machine token, the CLI and nobody keep the token of the environment (`forRun(null)` is the server's own token).
   * A token that cannot be used any more is a `GitAuthError`: the run waits for the person to reconnect.
   */
  async forRun(startedBy: string | null | undefined, codeHost?: string): Promise<RunHosts> {
    const connections = this.connectionStore;
    if (!connections || !startedBy || startedBy === 'machine') {
      return this.envHosts;
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
    return new RunHosts(
      this.entries.map(({ adapter, host }, index) => {
        const token = tokens[index];
        return { adapter, host: token === null || token === undefined ? host : host.withToken(token) };
      }),
    );
  }

  /** The one door to a host API for a run: the host with the token of its person. A host with no token or url is a refusal. */
  async hostFor(run: { codeHost: string; startedBy: string | null }): Promise<CodeHost> {
    const scoped = await this.forRun(run.startedBy, run.codeHost);
    scoped.requiredCredentials(run.codeHost);
    return scoped.byName(run.codeHost);
  }

  /** The tokens a git process of the server reads, those of the person of a run. */
  async tokensFor(startedBy: string | null | undefined, codeHost?: string): Promise<Partial<CodeHostEnv>> {
    return (await this.forRun(startedBy, codeHost)).tokens();
  }

  static create(env: CodeHostEnv, clock: Clock, connectionStore?: ConnectionsService): CodeHostRegistry {
    return new CodeHostRegistry(
      codeHostAdapters().map((adapter) => ({ adapter, host: adapter.create(env, clock) })),
      connectionStore,
    );
  }

  /** The login of each host, in the order of the adapters. */
  static loginProviders(
    env: CodeHostEnv,
    clock: Clock,
    apps: AppSource,
    resolveFlow?: (flow: Type<AppFlow>) => AppFlow,
  ): LoginProvider[] {
    return codeHostAdapters().map((adapter) => {
      const flow = adapter.appFlow;
      return adapter.login(env, clock, apps, flow && resolveFlow ? () => resolveFlow(flow) : undefined);
    });
  }

  /** How a person connects each host; none when the store of connections is absent. */
  connections(): Connection[] {
    const store = this.connectionStore;
    return store ? this.entries.map(({ adapter, host }) => adapter.connection(host.selected(), store)) : [];
  }

  has(name: string): boolean {
    return this.envHosts.has(name);
  }

  forOrigin(origin: string): CodeHostName | null {
    return this.envHosts.forOrigin(origin);
  }

  credentials(name: string): SelectedHost {
    return this.envHosts.credentials(name);
  }

  pushAuth(origin: string): { url: string | null; token: string } {
    return this.envHosts.pushAuth(origin);
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
