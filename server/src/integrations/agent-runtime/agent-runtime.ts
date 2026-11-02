import type { RuntimeName } from './agent-runtime.registry';

export type { RuntimeName };

export interface RuntimeKeys {
  cursorKey: string;
  anthropicKey: string;
  oauthToken: string;
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

export interface AgentRuntime {
  readonly name: RuntimeName;
  readonly command: 'agent' | 'claude';
  readonly image: string;
  readonly apiHosts: readonly string[];
  readonly credentialNames: readonly string[];
  readonly syncsChatMode: boolean;
  readonly priceSource: string;
  credential(keys: RuntimeKeys): { name: string; value: string };
  briefArgs(): string[];
  printArgs(input: AgentPrintInput): string[];
  terminalArgs(input: AgentTerminalInput): string[];
}
