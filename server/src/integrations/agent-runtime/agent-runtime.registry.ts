import type { AgentRuntime } from './agent-runtime';
import type { Connection } from '../connection';
import type { RuntimeName } from './runtime-name';
export { RUNTIME_NAMES, type RuntimeName } from './runtime-name';
import { ClaudeRuntime } from './claude/claude.runtime';
import { CodexRuntime } from './codex/codex.runtime';
import { CursorRuntime } from './cursor/cursor.runtime';

const runtimes: Record<RuntimeName, AgentRuntime> = {
  cursor: new CursorRuntime(),
  claude: new ClaudeRuntime(),
  codex: new CodexRuntime(),
};

/** The three runtimes, one each. */
function allRuntimes(): AgentRuntime[] {
  return [runtimes.cursor, runtimes.claude, runtimes.codex];
}

export function runtimeFor(name: string): AgentRuntime {
  if (name === 'claude') {
    return runtimes.claude;
  }
  if (name === 'codex') {
    return runtimes.codex;
  }
  return runtimes.cursor;
}

export function runtimeForCommand(command: string): AgentRuntime {
  if (command === 'agent') {
    return runtimes.cursor;
  }
  if (command === 'codex') {
    return runtimes.codex;
  }
  return runtimes.claude;
}

/** How a person connects each runtime that offers a connection. */
export function runtimeConnections(): Connection[] {
  return allRuntimes().flatMap((runtime) => (runtime.connection ? [runtime.connection] : []));
}
