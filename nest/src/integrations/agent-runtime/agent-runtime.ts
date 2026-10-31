import type { RuntimeName } from './agent-runtime.registry';

export type { RuntimeName };

export interface RuntimeKeys {
  cursorKey: string;
  anthropicKey: string;
  oauthToken: string;
}

export interface AgentRuntime {
  readonly name: RuntimeName;
  readonly command: string;
  readonly image: string;
  readonly apiHosts: readonly string[];
  readonly credentialNames: readonly string[];
  credential(keys: RuntimeKeys): { name: string; value: string };
}
