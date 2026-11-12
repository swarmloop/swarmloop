import { SwarmloopError } from '../../../core/swarmloop-error';
import { AbstractAgentRuntime } from '../abstract-agent-runtime';
import type { AgentPrintInput, AgentTerminalInput, EgressCredential, RuntimeKeys } from '../agent-runtime';
import { CODEX_LIMITS } from './codex-limit';

export const CODEX_KEY_PLACEHOLDER = 'sk-swarmloop-egress-placeholder';

export class CodexRuntime extends AbstractAgentRuntime {
  readonly name = 'codex' as const;
  readonly command = 'codex' as const;
  readonly syncsChatMode = false;
  readonly planModeHasPlanTool = false;
  readonly priceSource = 'https://platform.openai.com/docs/pricing';
  readonly apiHosts = ['api.openai.com', 'auth.openai.com', '*.chatgpt.com'];
  readonly credentialNames = ['CODEX_AUTH', 'CODEX_API_KEY'];
  protected readonly limits = CODEX_LIMITS;

  credential(keys: RuntimeKeys): { name: string; value: string } {
    if (keys.codexAuth !== '') {
      return { name: 'CODEX_AUTH', value: keys.codexAuth };
    }
    if (keys.codexApiKey !== '') {
      return { name: 'CODEX_API_KEY', value: keys.codexApiKey };
    }
    throw new SwarmloopError('CODEX_AUTH or CODEX_API_KEY is missing');
  }

  /**
   * With an API key Codex reads its base URL from `openai_base_url`, sends the placeholder, and the proxy sends the
   * key. A ChatGPT login refreshes its own tokens, so it stays in the container.
   */
  override egressCredential(credential: { name: string; value: string }, api: string): EgressCredential {
    if (credential.name !== 'CODEX_API_KEY') {
      return { env: [credential] };
    }
    return {
      env: [{ name: 'CODEX_API_KEY', value: CODEX_KEY_PLACEHOLDER }],
      args: ['-c', `openai_base_url="${api}/v1"`],
      api: { upstream: 'https://api.openai.com', header: 'authorization', value: `Bearer ${credential.value}` },
    };
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
