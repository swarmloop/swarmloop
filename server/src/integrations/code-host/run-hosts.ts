import { remoteProject } from './remote-project';
import { SwarmloopError } from '../../core/swarmloop-error';
import type { CodeHost, SelectedHost } from './code-host';
import type { AbstractCodeHost, CodeHostEnv } from './abstract-code-host';
import type { CodeHostAdapter } from './code-host-adapter';
import { codeHostAdapters } from './code-host-adapters';

export interface RunHostEntry {
  readonly adapter: CodeHostAdapter;
  readonly host: AbstractCodeHost;
}

/** The hosts of one person, or of the env token when there is no person. The only way to a host API. */
export class RunHosts {
  readonly names: readonly CodeHostAdapter['name'][] = codeHostAdapters().map((adapter) => adapter.name);

  constructor(private readonly entries: readonly RunHostEntry[]) {}

  has(name: string): boolean {
    return this.entries.some(({ host }) => host.name === name);
  }

  byName(name: string): CodeHost {
    return this.take(name);
  }

  forOrigin(origin: string): CodeHostAdapter['name'] | null {
    const matched = this.entries.map(({ host }) => host).filter((host) => host.matchesOrigin(origin));
    if (matched.length > 1) {
      throw new SwarmloopError(`${remoteProject(origin).host.toLowerCase()} matches both code hosts`);
    }
    const found = matched[0];
    return found ? found.name : null;
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

  /** The tokens a git process reads, one per host. */
  tokens(): Partial<CodeHostEnv> {
    return Object.fromEntries(this.entries.map(({ adapter, host }) => [adapter.tokenKey, host.selected().token]));
  }

  private take(name: string): CodeHost {
    const host = this.entries.find((item) => item.host.name === name)?.host;
    if (!host) {
      throw new SwarmloopError('code host is missing');
    }
    return host;
  }
}
