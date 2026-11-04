import { basename } from 'path';
import type { SandboxMount } from '../../sandbox/sandbox-launch';
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
        `${where}After you finish, swarmloop runs ${commands.map((command) => `\`${command}\``).join(' and then ')} in ${imageName(manifest, basename(mount.hostPath))} on your worktree. You cannot run them here, write the code so they pass.`,
      );
    }
  }
  return lines.join('\n');
}

/** The prompt with the note appended when there is one. */
export function withVerifyNote(prompt: string, note: string): string {
  return note ? `${prompt.trimEnd()}\n\n${note}\n` : prompt;
}
