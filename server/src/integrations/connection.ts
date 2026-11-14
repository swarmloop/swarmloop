import type { ConnectionCard, ConnectionFlow } from '../contract/connections';

/** What a provider answered to a test: the account it read, or its own message. */
export type ConnectionTestResult = { ok: true; account: string | null } | { ok: false; message: string };

/** The real calls a test makes: the adapter says what to ask, the probe does the call. */
export interface ConnectionProbe {
  /** The model ids a runtime's API lists for a key. */
  listModels(runtime: string, fields: Record<string, string>): Promise<string[]>;
  /** One HTTP request with the given headers; the answer is the status and the body text. */
  request(url: string, headers: Record<string, string>): Promise<{ status: number; body: string }>;
  /** Runs one command once in the runtime's agent image with the given credential env; `ok` is a zero exit. */
  check(
    runtime: string,
    env: { name: string; value: string }[],
    command: string[],
  ): Promise<{ ok: boolean; output: string }>;
}

/** What a CLI sign-in has printed so far, read from its output. */
export interface SignInParse {
  /** The link the person opens, or null until the CLI prints one. */
  link: string | null;
  /** The device code to show, or null. */
  code: string | null;
  /** True while the CLI waits for a code the person types. */
  asksForCode: boolean;
  /** The credential the CLI printed, by field name, or null until it has. */
  fields: Record<string, string> | null;
}

/** A sign-in that a CLI runs in the agent image: the command and how to read its output. It runs nothing itself. */
export interface SignInFlow {
  command(): string[];
  /** The hosts the CLI needs beyond the runtime's API hosts. */
  hosts: string[];
  timeoutMs: number;
  parse(output: string): SignInParse;
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
