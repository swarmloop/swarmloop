import type { AgentRuntime } from './agent-runtime';
import { ClaudeRuntime } from './claude/claude.runtime';
import { CursorRuntime } from './cursor/cursor.runtime';

export const RUNTIME_NAMES = ['cursor', 'claude'] as const;

export type RuntimeName = (typeof RUNTIME_NAMES)[number];

const runtimes: Record<RuntimeName, AgentRuntime> = {
  cursor: new CursorRuntime(),
  claude: new ClaudeRuntime(),
};

export function runtimeFor(name: string): AgentRuntime {
  return name === 'claude' ? runtimes.claude : runtimes.cursor;
}

export function runtimeForCommand(command: string): AgentRuntime {
  return command === 'agent' ? runtimes.cursor : runtimes.claude;
}
