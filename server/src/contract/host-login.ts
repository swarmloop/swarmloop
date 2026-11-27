/** One host on the Connections page. It never holds a token or a secret. */
export interface ConnectionView {
  host: string;
  /** What the host calls the app of its login: `App` or `Application`. */
  appLabel: string;
  /** True when the host has installations that choose repositories. */
  installs: boolean;
  /** The app or OAuth application of the host, by name and client id. Null when none is set up. */
  app: { name: string; clientId: string; madeBy?: string | null; settingsUrl?: string | null } | null;
  /** The login of the person, or null when they are not connected on this host. */
  account: string | null;
  /** `owner/name` of the repositories the installation covers. */
  repositories: string[];
  selection: 'all' | 'selected' | null;
  health: { status: 'ok' | 'broken'; expiresAt: string | null; refreshedAt: string | null } | null;
  /** `owner/name` of the repositories this server works on that neither the installation nor the server's token reaches. */
  unreachable?: string[];
  /**
   * For who may replace the app or application: the people a replace disconnects. For an app, everyone connected on
   * the host; for an application, the people whose connection holds a refresh token it issued.
   */
  connected?: string[];
  /** True for a stored app or application when the viewer is its maker or an admin. */
  mayReplace: boolean;
}

export interface ConnectionsView {
  connections: ConnectionView[];
}

/** A host where a person signs in by pasting a personal access token: where it is made. */
export interface TokenSignInView {
  provider: string;
  base: string;
  tokenPage: string;
}

/** What a person needs to register the OAuth application of a host. */
export interface ApplicationSetupView {
  /** The host name. */
  provider: string;
  /** The page of the host where the application is registered. */
  page: string;
  /** The callback URL to enter in the application. */
  callback: string;
  /** The scopes to tick, in the order the authorize request asks for them. */
  scopes: string[];
}

/** `/auth/providers`: the hosts with a login, and the hosts that take a token. */
export interface ProvidersView {
  providers: string[];
  tokens: TokenSignInView[];
  /** The hosts whose application a person registers; the form shows the page link, the callback URL to copy and the scopes to tick. */
  applications?: ApplicationSetupView[];
}
