import { SwarmloopError } from '../../../core/swarmloop-error';
import { AbstractAgentRuntime } from '../abstract-agent-runtime';
import type { AgentPrintInput, AgentTools, EgressCredential, HomeFile, RuntimeKeys } from '../agent-runtime';
import { CLAUDE_LIMITS } from './claude-limit';
import { DENY_BACKGROUND_HOOK, DENY_BACKGROUND_SCRIPT } from './claude-hook';

export const CLAUDE_KEY_PLACEHOLDER = 'sk-ant-api03-swarmloop-egress-placeholder';
export const CLAUDE_OAUTH_PLACEHOLDER = 'sk-ant-oat01-swarmloop-egress-placeholder';

/** Tools that start work or a trigger that cannot outlive a print-mode turn. */
const CLAUDE_DISALLOWED_TOOLS = ['Monitor', 'ScheduleWakeup', 'CronCreate', 'CronDelete', 'CronList', 'RemoteTrigger'];

/** What a `read` step cannot use; a `plan` step can also use `Skill`. Read, search and `Bash` stay: the read-only mount is the hard guarantee. */
const CLAUDE_READ_ONLY_DENIED = [
  'Edit',
  'Write',
  'NotebookEdit',
  'Task',
  'WebSearch',
  'WebFetch',
  'Workflow',
  'Skill',
  'SendMessage',
  'EnterWorktree',
  'ExitWorktree',
];

/** The `--disallowedTools` value of a step with these tools. */
export function claudeDisallowedTools(tools: AgentTools): string {
  const denied = {
    read: CLAUDE_READ_ONLY_DENIED,
    plan: CLAUDE_READ_ONLY_DENIED.filter((tool) => tool !== 'Skill'),
    write: [],
  }[tools];
  return [...CLAUDE_DISALLOWED_TOOLS, ...denied].join(',');
}

const HOOK_DIR = '.claude';

export class ClaudeRuntime extends AbstractAgentRuntime {
  readonly name = 'claude' as const;
  readonly command = 'claude' as const;
  readonly syncsChatMode = false;
  readonly planModeHasPlanTool = false;
  readonly priceSource = 'https://platform.claude.com/docs/en/about-claude/pricing.md';
  readonly apiHosts = ['api.anthropic.com'];
  readonly credentialNames = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
  protected readonly limits = CLAUDE_LIMITS;

  credential(keys: RuntimeKeys): { name: string; value: string } {
    if (keys.oauthToken !== '') {
      return { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: keys.oauthToken };
    }
    if (keys.anthropicKey === '') {
      throw new SwarmloopError('ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN is missing');
    }
    return { name: 'ANTHROPIC_API_KEY', value: keys.anthropicKey };
  }

  /** Claude Code sends the API key or the OAuth token to ANTHROPIC_BASE_URL. The proxy puts the real one in. */
  override egressCredential(credential: { name: string; value: string }, api: string): EgressCredential {
    const shared = [
      { name: 'ANTHROPIC_BASE_URL', value: api },
      { name: 'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', value: '1' },
    ];
    const upstream = 'https://api.anthropic.com';
    if (credential.name === 'CLAUDE_CODE_OAUTH_TOKEN') {
      return {
        env: [{ name: 'CLAUDE_CODE_OAUTH_TOKEN', value: CLAUDE_OAUTH_PLACEHOLDER }, ...shared],
        api: { upstream, header: 'authorization', value: `Bearer ${credential.value}` },
      };
    }
    return {
      env: [{ name: 'ANTHROPIC_API_KEY', value: CLAUDE_KEY_PLACEHOLDER }, ...shared],
      api: { upstream, header: 'x-api-key', value: credential.value },
    };
  }

  briefArgs(): string[] {
    return ['--add-dir', '/work/brief'];
  }

  protected override partialOutputFlag(): string {
    return '--include-partial-messages';
  }

  /** The state directory is the container's /home/sandbox, so the hook runs from there. */
  override homeFiles(): HomeFile[] {
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [{ type: 'command', command: `sh /home/sandbox/${HOOK_DIR}/${DENY_BACKGROUND_HOOK}` }],
          },
        ],
      },
    };
    return [
      { path: `${HOOK_DIR}/settings.json`, content: `${JSON.stringify(settings, null, 2)}\n`, mode: 0o644 },
      { path: `${HOOK_DIR}/${DENY_BACKGROUND_HOOK}`, content: DENY_BACKGROUND_SCRIPT, mode: 0o755 },
    ];
  }

  protected override appendPrintFlags(args: string[], input: AgentPrintInput): void {
    args.push('--verbose', '--disallowedTools', claudeDisallowedTools(input.tools));
    if (input.mode === 'plan' || input.mode === 'ask') {
      args.push('--permission-mode', 'plan');
      return;
    }
    args.push('--dangerously-skip-permissions');
  }
}
