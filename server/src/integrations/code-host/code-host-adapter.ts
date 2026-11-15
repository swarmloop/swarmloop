import type { Type } from '@nestjs/common';
import type { Clock } from '../../core/clock';
import type { Connection } from '../connection';
import type { AbstractCodeHost, CodeHostEnv } from './abstract-code-host';
import type { ConnectionStore } from './code-host-connection';
import type { CodeHostRules } from './host-rules';
import type { AppFlow, AppSource, LoginFacts, LoginProvider, ProviderName } from './login-provider';

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
  connection(host: { baseUrl: string; tokenKey: string }, store: ConnectionStore): Connection;
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
  /** What the host calls the app of its login. */
  readonly appLabel: LoginFacts['appLabel'];
  /** The prefixes of the `SWARMLOOP_ALLOW` entries that name a person and a group of the host. */
  readonly allowPrefixes: LoginFacts['allowPrefixes'];
  /** The env keys of the host's OAuth app. */
  readonly clientEnvKeys: LoginFacts['clientEnvKeys'];
  /** Whether one authorization signs in and keeps the person's tokens even without a stored app. */
  readonly keepsTokensWithoutApp: boolean;
  /** Whether the app of the host is one the person registers with the host, not a plain OAuth app. */
  readonly storesApplication: boolean;
  /** The Nest class of the host's app flow, when it has one. */
  readonly appFlow?: Type<AppFlow>;
  /** The login of the host. `appFlow` resolves the instance of the host's app flow. */
  login(env: CodeHostEnv, clock: Clock, apps: AppSource, appFlow?: () => AppFlow): LoginProvider;
}
