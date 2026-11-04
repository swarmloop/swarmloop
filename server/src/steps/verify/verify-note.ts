import { basename } from 'path';
import type { SandboxMount } from '../../sandbox/sandbox-launch';
import type { VerifyBridgeInput } from '../../agent/verify-bridge';
import { readManifest, type SwarmloopManifest } from '../../verify/manifest';
import { imageName } from '../../verify/verify-image';
import { baseRef } from '../code-review/review-diff';

/** The manifest on the base ref of a worktree. Null when there is none, the ref is missing, or the file is invalid. */
export async function baseManifest(worktree: string): Promise<SwarmloopManifest | null> {
  const base = await baseRef(worktree);
  if (!base) {
    return null;
  }
  try {
    return (await readManifest(worktree, base))?.manifest ?? null;
  } catch {
    return null;
  }
}

/** Tells the agent what swarmloop runs after it finishes. Empty when no repository has a manifest. */
export async function verifyNote(mounts: SandboxMount[]): Promise<string> {
  const lines: string[] = [];
  for (const mount of mounts) {
    const manifest = await baseManifest(mount.hostPath);
    if (manifest) {
      const commands = [...(manifest.install ? [manifest.install] : []), ...manifest.verify];
      const where = mounts.length > 1 ? `${basename(mount.hostPath)}: ` : '';
      lines.push(
        `${where}You can run \`swarmloop-verify\` (optionally with a repository name) in the shell. It runs ${commands.map((command) => `\`${command}\``).join(' and then ')} in ${imageName(manifest, basename(mount.hostPath))} on your worktree. Run it when a coherent piece of work is done and always before your final summary. If it fails, fix the cause and run it again; do not call it after every small edit. When it says it is not configured, ignore it.`,
      );
    }
  }
  return lines.join('\n');
}

/** The prompt with the note appended when there is one. */
export function withVerifyNote(prompt: string, note: string): string {
  return note ? `${prompt.trimEnd()}\n\n${note}\n` : prompt;
}

/** The implementation-only bridge uses the prepared base ref, never agent-supplied commands. */
export async function agentVerifyInput(
  mounts: SandboxMount[],
  maxCalls: number,
): Promise<VerifyBridgeInput | undefined> {
  const first = mounts[0];
  if (!first) {
    return undefined;
  }
  const base = await baseRef(first.hostPath);
  if (!base) {
    return undefined;
  }
  return {
    repos: mounts.map((mount) => ({ name: basename(mount.hostPath), path: mount.hostPath })),
    baseRef: base,
    maxCalls,
  };
}
