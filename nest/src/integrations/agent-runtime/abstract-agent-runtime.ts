import type { AgentRuntime, RuntimeKeys, RuntimeName } from './agent-runtime';

export abstract class AbstractAgentRuntime implements AgentRuntime {
  abstract readonly name: RuntimeName;
  abstract readonly command: string;

  get image(): string {
    return `swarmloop-agent-${this.name}`;
  }

  abstract readonly apiHosts: readonly string[];
  abstract readonly credentialNames: readonly string[];

  abstract credential(keys: RuntimeKeys): { name: string; value: string };
}
