import type { ConnectionsService } from '../../auth/connections.service';
import type { ProviderName } from '../../auth/oauth-provider';
import type { Clock } from '../../core/clock';
import type { Connection } from '../connection';
import type { AbstractCodeHost, CodeHostEnv } from './abstract-code-host';
import type { CodeHostRules } from './host-rules';

/** Everything the core knows of one code host. A host is one folder with an index module that exports it as `adapter`. */
export interface CodeHostAdapter {
  readonly name: ProviderName;
  /** The display name of the host. */
  readonly label: string;
  /** The env key of the host's base url. */
  readonly baseKey: keyof CodeHostEnv;
  /** The env key of the host's server token. */
  readonly tokenKey: keyof CodeHostEnv;
  create(env: CodeHostEnv, clock: Clock): AbstractCodeHost;
  readonly rules: CodeHostRules;
  /** How a person connects the host on the Connections page. */
  connection(host: { baseUrl: string; tokenKey: string }, store: ConnectionsService): Connection;
  /** Hosts try to build a push url in this order, the lowest first. */
  readonly pushOrder: number;
  /** The host a new repository goes to when the request names none. */
  readonly createsByDefault: boolean;
  /** Hosts the package managers of the sandbox download archives from. */
  readonly packageHosts: readonly string[];
  /** Hosts the setup downloads release binaries from. */
  readonly setupDownloads: readonly string[];
  /** The public, hosted site of the host. */
  readonly publicHost: string;
  /** Whether a repository created here is recorded on the person who created it. */
  readonly ownerFromActor: boolean;
}
