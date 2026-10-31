import { SwarmloopError } from '../../swarmloop-error';
import type { AgentPrintInput, AgentRuntime, AgentTerminalInput, RuntimeKeys, RuntimeName } from './agent-runtime';

export abstract class AbstractAgentRuntime implements AgentRuntime {
  abstract readonly name: RuntimeName;
  abstract readonly command: 'agent' | 'claude';
  abstract readonly syncsChatMode: boolean;
  abstract readonly priceSource: string;

  get image(): string {
    return `swarmloop-agent-${this.name}`;
  }

  abstract readonly apiHosts: readonly string[];
  abstract readonly credentialNames: readonly string[];

  abstract credential(keys: RuntimeKeys): { name: string; value: string };

  abstract briefArgs(): string[];

  printArgs(input: AgentPrintInput): string[] {
    const workspace = input.mounts[0]?.containerPath;
    if (!workspace) {
      throw new SwarmloopError('sandbox mount is missing');
    }
    const args = [
      '--print',
      '--output-format',
      'stream-json',
      '--stream-partial-output',
      '--model',
      input.model,
      '--trust',
      '--workspace',
      workspace,
    ];
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
    const args = ['--model', input.model, '--trust', '--workspace', input.workspace];
    if (input.resumeChatId) {
      args.push('--resume', input.resumeChatId);
    }
    return args;
  }

  protected appendPrintFlags(_args: string[], _input: AgentPrintInput): void {}
}
