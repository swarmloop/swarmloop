import { SwarmloopError } from '../../core/swarmloop-error';
import type {
  AgentPrintInput,
  AgentRuntime,
  AgentTerminalInput,
  EgressCredential,
  HomeFile,
  RuntimeKeys,
  RuntimeName,
} from './agent-runtime';
import { classifyLimit, type LimitHit, type LimitInput, type LimitRule } from './runtime-limit';

export abstract class AbstractAgentRuntime implements AgentRuntime {
  abstract readonly name: RuntimeName;
  abstract readonly command: 'agent' | 'claude' | 'codex';
  abstract readonly syncsChatMode: boolean;
  abstract readonly planModeHasPlanTool: boolean;
  abstract readonly priceSource: string;

  get component(): `agent-${RuntimeName}` {
    return `agent-${this.name}`;
  }

  abstract readonly apiHosts: readonly string[];
  abstract readonly credentialNames: readonly string[];
  /** The samples of this CLI's limit texts. */
  protected abstract readonly limits: readonly LimitRule[];

  classifyLimit(input: LimitInput): LimitHit | null {
    return classifyLimit(this.limits, input);
  }

  /** By default the key stays in the container: the vendor's login does not allow a stand-in. */
  egressCredential(credential: { name: string; value: string }, _api: string): EgressCredential {
    return { env: [credential] };
  }

  abstract credential(keys: RuntimeKeys): { name: string; value: string };

  abstract ownRuleFiles(): readonly string[];

  abstract briefArgs(): string[];

  printArgs(input: AgentPrintInput): string[] {
    const workspace = input.mounts[0]?.containerPath;
    if (!workspace) {
      throw new SwarmloopError('sandbox mount is missing');
    }
    const args = ['--print', '--output-format', 'stream-json'];
    const partial = this.partialOutputFlag();
    if (partial) {
      args.push(partial);
    }
    args.push('--model', input.model, ...this.workspaceArgs(workspace));
    if (input.resumeChatId) {
      args.push('--resume', input.resumeChatId);
    }
    this.appendPrintFlags(args, input);
    args.push(input.prompt);
    return args;
  }

  terminalArgs(input: AgentTerminalInput): string[] {
    if (input.vendor.length > 0) {
      return [...input.vendor];
    }
    const args = ['--model', input.model, ...this.workspaceArgs(input.workspace)];
    if (input.resumeChatId) {
      args.push('--resume', input.resumeChatId);
    }
    return args;
  }

  homeFiles(): HomeFile[] {
    return [];
  }

  protected appendPrintFlags(_args: string[], _input: AgentPrintInput): void {}

  protected partialOutputFlag(): string | null {
    return null;
  }

  protected workspaceArgs(_workspace: string): string[] {
    return [];
  }
}
