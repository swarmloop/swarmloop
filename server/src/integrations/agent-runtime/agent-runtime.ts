import type { RuntimeName } from './runtime-name';

export type { RuntimeName };

export interface RuntimeKeys {
  cursorKey: string;
  anthropicKey: string;
  oauthToken: string;
  codexAuth: string;
  codexApiKey: string;
}

export interface AgentPrintInput {
  model: string;
  prompt: string;
  mounts: readonly { containerPath: string }[];
  resumeChatId: string | null;
  mode?: string;
  approveMcps?: boolean;
}

export interface AgentTerminalInput {
  model: string;
  workspace: string;
  resumeChatId: string | null;
  vendor: string[];
}

/** What the container gets when the egress proxy holds the key: a placeholder, and how the proxy sends the real one. */
export interface EgressCredential {
  env: { name: string; value: string }[];
  /** Arguments that go right after the CLI name, such as a base URL the CLI reads only from its flags. */
  args?: string[];
  /** The model API the proxy calls with the real key. Absent when the key has to stay in the container. */
  api?: { upstream: string; header: string; value: string };
}

export interface AgentRuntime {
  readonly name: RuntimeName;
  readonly command: 'agent' | 'claude' | 'codex';
  readonly image: string;
  readonly apiHosts: readonly string[];
  readonly credentialNames: readonly string[];
  readonly syncsChatMode: boolean;
  readonly priceSource: string;
  credential(keys: RuntimeKeys): { name: string; value: string };
  briefArgs(): string[];
  printArgs(input: AgentPrintInput): string[];
  terminalArgs(input: AgentTerminalInput): string[];
  /** The credential for a container behind the egress proxy. */
  egressCredential(credential: { name: string; value: string }, api: string): EgressCredential;
}
