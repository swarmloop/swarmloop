import { SwarmloopError } from '../../../core/swarmloop-error';
import { EFFORTS, type Effort } from '../../../contract/effort';
import { AbstractAgentRuntime } from '../abstract-agent-runtime';
import type {
  AgentHelper,
  AgentPrintInput,
  AgentTools,
  EffortLaunch,
  EgressCredential,
  HomeFile,
  PromptCache,
  RuntimeKeys,
} from '../agent-runtime';
import { ClaudeConnection } from './claude-connection';
import { CLAUDE_LIMITS } from './claude-limit';
import { CLAUDE_OUTAGES } from './claude-outage';
import {
  DENY_BACKGROUND_HOOK,
  DENY_BACKGROUND_SCRIPT,
  READ_BY_HELPER_HOOK,
  READ_BY_HELPER_SCRIPT,
} from './claude-hook';

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

/** What a `none` step cannot use besides the above: it answers from its prompt alone. */
const CLAUDE_NO_TOOLS_DENIED = [
  ...CLAUDE_READ_ONLY_DENIED,
  'Read',
  'Grep',
  'Glob',
  'Bash',
  'BashOutput',
  'KillShell',
  'TodoWrite',
];

/** The `--disallowedTools` value of a step with these tools. */
export function claudeDisallowedTools(tools: AgentTools): string {
  const denied = {
    none: CLAUDE_NO_TOOLS_DENIED,
    read: CLAUDE_READ_ONLY_DENIED,
    plan: CLAUDE_READ_ONLY_DENIED.filter((tool) => tool !== 'Skill'),
    write: [],
  }[tools];
  return [...CLAUDE_DISALLOWED_TOOLS, ...denied].join(',');
}

/**
 * Claude Code 2.1.319 (`claude --help`: `--agents <json>`; https://code.claude.com/docs/en/sub-agents). The subagent tool is
 * `Agent`, with `Task` as its old name; a deny rule `Agent(<type>)` denies one subagent type. A definition sets `model`,
 * `effort` and `tools`. These built-in types are denied, so only the helper's own reader runs.
 */
const CLAUDE_SUBAGENT_TOOLS = ['Agent', 'Task'];
const CLAUDE_BUILT_IN_SUBAGENTS = ['Explore', 'Plan', 'general-purpose', 'statusline-setup', 'claude-code-guide'];
const CLAUDE_HELPER_TOOLS = ['Read', 'Grep', 'Glob', 'Bash'];
const CLAUDE_HELPER_PROMPT =
  'Read what you are asked to read and report each fact with its file and line. Never change a file.';

/** The `--disallowedTools` value of a launch with a helper: the subagent tool is let through, its built-in types are not. */
function helperDisallowedTools(tools: AgentTools): string {
  const kept = claudeDisallowedTools(tools)
    .split(',')
    .filter((tool) => !CLAUDE_SUBAGENT_TOOLS.includes(tool));
  return [...kept, ...CLAUDE_BUILT_IN_SUBAGENTS.map((type) => `Agent(${type})`)].join(',');
}

/** The `--agents` value: one reader on the helper's model and level, with the tools that read. */
function helperAgents(helper: AgentHelper): string {
  const reader = {
    description: 'Reads code, briefs, logs and diffs and reports facts with file and line. It changes nothing.',
    prompt: CLAUDE_HELPER_PROMPT,
    model: helper.model,
    ...(helper.effort ? { effort: helper.effort } : {}),
    tools: CLAUDE_HELPER_TOOLS,
  };
  return JSON.stringify({ reader });
}

/** The 1-hour cache prices in USD per million tokens of the models Claude is known for; https://platform.claude.com/docs/en/build-with-claude/prompt-caching */
const CLAUDE_PROMPT_CACHES: ReadonlyMap<string, PromptCache> = new Map([
  ['claude-opus-5-5', { ttlMinutes: 60, cacheReadPerMillion: 0.2, cacheWritePerMillion: 8 }],
  ['claude-sonnet-5-5', { ttlMinutes: 60, cacheReadPerMillion: 0.2, cacheWritePerMillion: 4 }],
]);

/** The context window in tokens of the models Claude is known for; https://platform.claude.com/docs/en/about-claude/models */
const CLAUDE_CONTEXT_TOKENS: ReadonlyMap<string, number> = new Map([
  ['claude-opus-5-5', 1_000_000],
  ['claude-sonnet-5-5', 1_000_000],
]);

const HOOK_DIR = '.claude';

/**
 * Claude Code 2.1.319 (https://code.claude.com/docs/en/hooks, /permissions). Not confirmed against the docs, and to be
 * checked on one real turn: a Read deny rule also reaches Grep and Glob best-effort, and the launch's deny rules reach a
 * subagent, so a rule on the mounts would take away the search and the reader. A PreToolUse hook gets `agent_id` only
 * from a subagent's call, so it holds the agent alone. `--settings`
 * adds it for this launch, with the code mounts as its arguments.
 */
function readByHelperSettings(mounts: readonly { containerPath: string }[]): string {
  const paths = mounts.map((mount) => mount.containerPath).join(' ');
  const command = `sh /home/sandbox/${HOOK_DIR}/${READ_BY_HELPER_HOOK} ${paths}`;
  return JSON.stringify({
    hooks: { PreToolUse: [{ matcher: 'Read|Glob|Bash', hooks: [{ type: 'command', command }] }] },
  });
}

export class ClaudeRuntime extends AbstractAgentRuntime {
  readonly name = 'claude' as const;
  readonly command = 'claude' as const;
  readonly syncsChatMode = false;
  readonly planModeHasPlanTool = false;
  readonly hasHelpers = true;
  readonly priceSource = 'https://platform.claude.com/docs/en/about-claude/pricing.md';
  readonly apiHosts = ['api.anthropic.com'];
  readonly connection = new ClaudeConnection();
  readonly credentialNames = ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'];
  protected readonly limits = CLAUDE_LIMITS;
  protected readonly outages = CLAUDE_OUTAGES;
  protected readonly modelHost = 'api.anthropic.com';

  secrets(keys: RuntimeKeys): string[] {
    return [keys.oauthToken, keys.anthropicKey].filter(Boolean);
  }

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

  promptCache(model: string): PromptCache | null {
    return CLAUDE_PROMPT_CACHES.get(model) ?? null;
  }

  contextTokens(model: string): number | null {
    return CLAUDE_CONTEXT_TOKENS.get(model) ?? null;
  }

  // Claude Code 2.1.319 loads CLAUDE.md only: https://code.claude.com/docs/en/memory
  ownRuleFiles(): readonly string[] {
    return ['CLAUDE.md'];
  }

  briefArgs(): string[] {
    return ['--add-dir', '/work/brief'];
  }

  readDirArgs(dir: string): string[] {
    return ['--add-dir', dir];
  }

  override efforts(_model: string): readonly Effort[] {
    return EFFORTS;
  }

  /** `CLAUDE_CODE_EFFORT_LEVEL` beats `--effort` without a warning, so it is cleared and the flag is what counts. */
  override withEffort(launch: EffortLaunch, level: Effort): EffortLaunch {
    const set = this.insertAfterModel(launch, '--model', ['--effort', level]);
    return { ...set, unsetEnv: [...set.unsetEnv, 'CLAUDE_CODE_EFFORT_LEVEL'] };
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
      { path: `${HOOK_DIR}/${READ_BY_HELPER_HOOK}`, content: READ_BY_HELPER_SCRIPT, mode: 0o755 },
    ];
  }

  protected override appendPrintFlags(args: string[], input: AgentPrintInput): void {
    if (input.fork) {
      args.push('--fork-session', '--no-session-persistence');
    }
    const denied = input.helper ? helperDisallowedTools(input.tools) : claudeDisallowedTools(input.tools);
    args.push('--verbose', '--disallowedTools', denied);
    if (input.helper) {
      args.push('--agents', helperAgents(input.helper));
      if (input.helper.codeOnlyByHelper) {
        args.push('--settings', readByHelperSettings(input.mounts));
      }
    }
    if (input.mode === 'plan' || input.mode === 'ask') {
      args.push('--permission-mode', 'plan');
      return;
    }
    args.push('--dangerously-skip-permissions');
  }
}
