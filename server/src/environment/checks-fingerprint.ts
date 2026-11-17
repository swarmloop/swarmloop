import { createHash } from 'crypto';
import type { SandboxMount } from '../core/sandbox-mount';
import type { CheckEntry } from './environment-config';
import { checkoutSnapshot } from '../git/worktree-git';

/** What the fingerprint reads of a prepared environment. */
interface FingerprintEnvironment {
  launch: { image: string };
  record: { config: { checks: CheckEntry[]; hosts?: unknown }; setup?: { command: string } };
}

/** The immutable id of the image the checks run in. */
export async function checksImageId(
  docker: (args: string[], timeoutMs?: number) => Promise<string>,
  image: string,
): Promise<string> {
  return (await docker(['image', 'inspect', '--format', '{{.Id}}', image], 60_000)).trim();
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
  const imageId = await checksImageId(docker, prepared.launch.image);
  const { record } = prepared;
  return createHash('sha256')
    .update(
      [
        await checkoutSnapshot(input.mounts),
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
