import { SwarmloopError } from '../../../swarmloop-error';
import { AbstractAgentRuntime } from '../abstract-agent-runtime';
import type { AgentPrintInput, RuntimeKeys } from '../agent-runtime';

export class ClaudeRuntime extends AbstractAgentRuntime {
  readonly name = 'claude' as const;
  readonly command = 'claude' as const;
  readonly syncsChatMode = false;
  readonly priceSource = 'https://platform.claude.com/docs/en/about-claude/pricing.md';
  readonly apiHosts = ['api.anthropic.com'];
  readonly credentialNames = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];

  credential(keys: RuntimeKeys): { name: string; value: string } {
    if (keys.oauthToken !== '') {
      return { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: keys.oauthToken };
    }
    if (keys.anthropicKey === '') {
      throw new SwarmloopError('ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is missing');
    }
    return { name: 'ANTHROPIC_API_KEY', value: keys.anthropicKey };
  }

  briefArgs(): string[] {
    return ['--add-dir', '/work/brief'];
  }

  protected partialOutputFlag(): string {
    return '--include-partial-messages';
  }

  protected appendPrintFlags(args: string[], input: AgentPrintInput): void {
    args.push('--verbose');
    if (input.mode === 'plan' || input.mode === 'ask') {
      args.push('--permission-mode', 'plan');
      return;
    }
    args.push('--dangerously-skip-permissions');
  }
}
