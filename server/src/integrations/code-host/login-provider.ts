import type { CodeHostLoginEnv } from '../../config/env';

export type ProviderName = string;

/** A repository of a checkout, on the host its origin points to. */
export interface RepoRef {
  host: ProviderName;
  owner: string;
  name: string;
}

/** The tokens a login granted, for a provider that keeps them. */
export interface Grant {
  accessToken: string;
  refreshToken: string;
  /** Seconds the access token lives, or undefined when it does not expire. */
  expiresIn?: number;
}

export interface Identity {
  user: string;
  avatarUrl?: string;
  /** The orgs or groups the person belongs to. */
  groups: string[];
  /** Set when the provider connects the person: one authorization signs in and connects. */
  grant?: Grant;
}

/** The client id and secret of the app a login goes through. */
export interface AppCredentials {
  clientId: string;
  clientSecret: string;
}

/** Where a provider finds its app: the one Connect stored, else the OAuth app of the environment. */
export interface AppSource {
  credentials(host: ProviderName): AppCredentials | null;
  connects(host: ProviderName): boolean;
}

/** A stored app: all fields for an app with a private key, else the client id and secret. */
export interface StoredApp {
  host: ProviderName;
  appId: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  privateKey: string;
  /** The login of the person who made the app, or `first-run` until the first person signs in. Null for an app made earlier. */
  madeBy: string | null;
}

/** Where the apps of the hosts are stored. */
export interface HostAppStore {
  find(host: ProviderName): StoredApp | null;
  save(app: StoredApp): Promise<void>;
}

export const HOST_APP_STORE = 'HOST_APP_STORE';

export interface ManifestForm {
  /** Where the browser posts the manifest. */
  action: string;
  manifest: Record<string, unknown>;
}

/** The app a host makes from a manifest, and the install of it. */
export interface AppFlow {
  manifest(owner: string | undefined, state: string): Promise<ManifestForm>;
  installUrl(slug: string, state: string): string;
  convert(code: string, madeBy: string): Promise<string>;
  installedAccount(installationId: string): Promise<string | null>;
}

export interface LoginProvider {
  readonly name: ProviderName;
  /** The display name of the host. */
  readonly label: string;
  /** What the host calls the app of its login. */
  readonly appLabel: string;
  /** The prefixes of the `SWARMLOOP_ALLOW` entries that name a person and a group of this host. */
  readonly allowPrefixes: { user: string; group: string };
  /** The env keys of the OAuth app of the environment. */
  readonly clientEnvKeys: {
    clientId: keyof CodeHostLoginEnv;
    clientSecret: keyof CodeHostLoginEnv;
  };
  /** The host's optional app flow. */
  readonly appFlow?: AppFlow;
  /** Both the client id and the secret are set. */
  configured(): boolean;
  /** True when the login also keeps the person's tokens. */
  connects(): boolean;
  authorizeUrl(redirectUri: string, state: string, verifier: string): string;
  /** Trades the code for a token, reads the login and memberships, and drops the token unless the provider connects. An empty verifier means the code was not asked for with PKCE. */
  identify(code: string, redirectUri: string, verifier: string): Promise<Identity>;
  /** The owner of the configured server token, or null when none is set. */
  tokenOwner(): Promise<string | null>;
  /** True when the token can push to at least one of `repos`. A repository the token cannot see counts as no push. */
  canPush(token: string, repos: RepoRef[]): Promise<boolean>;
}

/** The facts of a host a login provider carries as they are. */
export type LoginFacts = Pick<LoginProvider, 'name' | 'label' | 'appLabel' | 'allowPrefixes' | 'clientEnvKeys'>;

export interface Endpoints {
  /** What the host calls the app of its login. */
  appLabel: string;
  /** True when the host has installations that choose repositories. */
  installs: boolean;
  authorize: string;
  token: string;
  api: string;
  scope: string;
  /** The call that names the person, and the field that holds the login. */
  user: { path: string; field: string };
  /** The call that lists orgs or groups, and the field that holds each name. */
  groups: { path: string; field: string };
  userHeaders(token: string): Record<string, string>;
  /** The API path of a repository. */
  repoPath(ref: RepoRef): string;
  /** Whether the repository row says the token can push. */
  pushes(row: Record<string, unknown>): boolean;
}
