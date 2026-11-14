import type { ConnectionCard, ConnectionFlow, SignInView } from '../contract/connections';

/** What a provider answered to a test: the account it read, or its own message. */
export type ConnectionTestResult = { ok: true; account: string | null } | { ok: false; message: string };

/** The real calls a test makes: the adapter says what to ask, the probe does the call. */
export interface ConnectionProbe {
  /** The model ids a runtime's API lists for a key. */
  listModels(runtime: string, fields: Record<string, string>): Promise<string[]>;
  /** One HTTP request with the given headers; the answer is the status and the body text. */
  request(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }>;
}

/** A sign-in that runs outside the page and shows a link and a code. */
export interface SignInFlow {
  start(login: string): Promise<SignInView>;
  poll(id: string): Promise<SignInView>;
  /** Hands the code the person typed to a CLI that asked for one. */
  submit(id: string, code: string): Promise<SignInView>;
}

/** For an integration that keeps its credential in a store of its own, not in the per-person secret store. */
export interface ConnectionOwnStore {
  status(login: string): Promise<Pick<ConnectionCard, 'status' | 'account' | 'reason'>>;
  disconnect(login: string): Promise<void>;
  fields(login: string): Promise<Record<string, string> | null>;
}

/** What the Connections page needs from one integration. */
export interface Connection {
  readonly id: string;
  /** The key of the logo in the dashboard's logo map. */
  readonly logo: string;
  readonly label: string;
  readonly purpose: string;
  readonly ownStore?: ConnectionOwnStore;
  /** The flows the card offers. */
  flows(): ConnectionFlow[];
  /** True when the server's env holds a credential for this integration. */
  envDefault(env: object): boolean;
  /** The values in `fields` that are secrets; the first one gives the last four characters the card shows. */
  secrets(fields: Record<string, string>): string[];
  /** A real call with the fields; nothing is stored before it answers `ok`. */
  test(fields: Record<string, string>, probe: ConnectionProbe): Promise<ConnectionTestResult>;
  /** The sign-in this integration offers, when a flow of kind `cli-code` or `device-code` is among its flows. */
  signIn?(): SignInFlow;
}
