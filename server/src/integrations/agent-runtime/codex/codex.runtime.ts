import { SwarmloopError } from '../../../core/swarmloop-error';
import { AbstractAgentRuntime } from '../abstract-agent-runtime';
import type { AgentPrintInput, AgentTerminalInput, RuntimeKeys } from '../agent-runtime';

export class CodexRuntime extends AbstractAgentRuntime {
  readonly name = 'codex' as const;
  readonly command = 'codex' as const;
  readonly syncsChatMode = false;
  readonly priceSource = 'https://platform.openai.com/docs/pricing';
  readonly apiHosts = ['api.openai.com', 'chatgpt.com', 'auth.openai.com'];
  readonly credentialNames = ['CODEX_AUTH', 'CODEX_API_KEY'];

  credential(keys: RuntimeKeys): { name: string; value: string } {
    if (keys.codexAuth !== '') {
      return { name: 'CODEX_AUTH', value: keys.codexAuth };
    }
    if (keys.codexApiKey !== '') {
      return { name: 'CODEX_API_KEY', value: keys.codexApiKey };
    }
    throw new SwarmloopError('CODEX_AUTH or CODEX_API_KEY is missing');
  }

  briefArgs(): string[] {
    return ['--add-dir', '/work/brief'];
  }

  override printArgs(input: AgentPrintInput): string[] {
    const args = [
      'exec',
      '--json',
      '--skip-git-repo-check',
      '-m',
      input.model,
      '--dangerously-bypass-approvals-and-sandbox',
    ];
    if (input.resumeChatId) {
      args.push('resume', input.resumeChatId);
    }
    args.push(input.prompt);
    return args;
  }

  override terminalArgs(input: AgentTerminalInput): string[] {
    if (input.vendor.length > 0) {
      return [...input.vendor];
    }
    const args = ['-m', input.model, '-C', input.workspace];
    if (input.resumeChatId) {
      args.push('resume', input.resumeChatId);
    }
    return args;
  }

  protected override partialOutputFlag(): string | null {
    return null;
  }
}
