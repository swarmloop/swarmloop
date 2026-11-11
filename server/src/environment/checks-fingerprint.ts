import { createHash } from 'crypto';
import type { SandboxMount } from '../core/sandbox-mount';
import { worktreeSnapshot } from '../git/worktree-git';

/** What the fingerprint reads of a prepared environment. */
interface FingerprintEnvironment {
  launch: { image: string };
  record: { config: { checks: string[]; hosts?: unknown }; setup?: { command: string } };
}

/**
 * Identifies what a check run judges: every mounted tree (HEAD and content, untracked files included), the image the
 * checks run in as an immutable id, and the frozen checks and setup commands.
 */
export async function checksFingerprint(
  input: { mounts: SandboxMount[] },
  prepared: FingerprintEnvironment,
  docker: (args: string[], timeoutMs?: number) => Promise<string>,
): Promise<string> {
  const imageId = (await docker(['image', 'inspect', '--format', '{{.Id}}', prepared.launch.image], 60_000)).trim();
  const { record } = prepared;
  return createHash('sha256')
    .update(
      [
        await worktreeSnapshot(input.mounts),
        imageId,
        JSON.stringify([
          record.config.checks,
          record.setup?.command,
          ...(record.config.hosts ? [record.config.hosts] : []),
        ]),
      ].join('\0'),
    )
    .digest('hex');
}
