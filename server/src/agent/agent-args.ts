import { chmodSync, existsSync, mkdirSync, readdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { runtimeForCommand } from '../integrations/agent-runtime/agent-runtime.registry';
import { cleanFileName } from '../core/clean-file-name';
import type { SandboxMount } from '../core/sandbox-mount';
import type { AgentTools } from '../integrations/agent-runtime/agent-runtime';
import { sessionGroup } from '../history/session-group';

/** Brief files for a chat. A code reviewer mounts its own directory. */
export function reviewBriefMount(statePath: string, step: string): SandboxMount | null {
  if (!sessionGroup(step) && !step.startsWith('code-review-')) {
    return null;
  }
  const dir = join(statePath, 'briefs');
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o755);
  return { hostPath: dir, containerPath: '/work/brief', readonly: true };
}

export function briefMounts(statePath: string, step: string, spilled: SandboxMount[]): SandboxMount[] {
  const review = reviewBriefMount(statePath, step);
  if (!review || spilled.some((mount) => mount.containerPath === review.containerPath)) {
    return spilled;
  }
  return [...spilled, review];
}

/** The run's files, read only, nested in `/work/brief`. A run without files has no such mount. */
export function attachmentsMount(hostPath: string): SandboxMount | null {
  const files = existsSync(hostPath) ? readdirSync(hostPath) : [];
  return files.length > 0 ? { hostPath, containerPath: '/work/brief/attachments', readonly: true } : null;
}

/** Linux rejects one argv string longer than MAX_ARG_STRLEN (128KiB). */
const ARG_BYTE_LIMIT = 100_000;

export function spillPrompt(prompt: string, statePath: string, step: string): { text: string; mounts: SandboxMount[] } {
  if (Buffer.byteLength(prompt) <= ARG_BYTE_LIMIT) {
    return { text: prompt, mounts: [] };
  }
  const name = briefName(step);
  const dir = join(statePath, 'briefs');
  mkdirSync(dir, { recursive: true });
  chmodSync(dir, 0o755);
  const file = join(dir, name);
  writeFileSync(file, prompt);
  chmodSync(file, 0o644);
  return {
    text: [
      `Read /work/brief/${name} and follow that assignment exactly.`,
      'That file is the whole brief. Do not ask for it again.',
    ].join('\n'),
    mounts: [{ hostPath: dir, containerPath: '/work/brief', readonly: true }],
  };
}

function briefName(step: string): string {
  return `${cleanFileName(step, 'brief')}.md`;
}

export function buildAgentArgs(
  command: string,
  input: {
    model: string;
    prompt: string;
    mounts: SandboxMount[];
    resumeChatId: string | null;
    mode?: string;
    tools: AgentTools;
  },
): string[] {
  return runtimeForCommand(command).printArgs(input);
}

/** A read-only plan or ask run mounts the work tree read-only, so the agent cannot edit it. */
export function readOnlyTree(runtime: string, mode: string | undefined): boolean {
  return runtime === 'codex' && (mode === 'plan' || mode === 'ask');
}
