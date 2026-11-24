import type { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import type { SandboxMount } from '../../core/sandbox-mount';
import { requiredTreeFingerprint, worktreeFingerprint } from '../../git/worktree-git';
import { countsFor } from '../../history/gate-stamp';

function mountsOf(hostPaths: string[]): SandboxMount[] {
  return [...hostPaths].sort().map((hostPath) => ({ hostPath, containerPath: '/work' }));
}

/** The fingerprint of the run's own worktrees at these paths, in one order whoever asks. A worktree with no tree fails. */
export function worktreesFingerprint(hostPaths: string[]): Promise<string> {
  return requiredTreeFingerprint(mountsOf(hostPaths));
}

/** The fingerprint of a person's checkout: a folder that is not a repository of its own adds only its name. */
export function checkoutFingerprint(hostPaths: string[]): Promise<string> {
  return worktreeFingerprint(mountsOf(hostPaths));
}

/**
 * The fingerprint of the tree a review judges. A person's checkout may be a subdirectory of a repository: it keeps the
 * name-only fingerprint. The run's own worktrees need a tree.
 */
export function reviewedTreeFingerprint(run: Pick<RunEntity, 'targetPath'>, hostPaths: string[]): Promise<string> {
  return (run.targetPath ? checkoutFingerprint : worktreesFingerprint)(hostPaths);
}

/** Stamps the latest document of `kind` for the generation of the run and the files it judged. */
export function stampGate(
  documents: DocumentRepository,
  run: RunEntity,
  kind: string,
  fingerprint: string,
): Promise<void> {
  return documents.stampLatest(run, kind, { generation: run.generation, fingerprint });
}

/** True when the latest document of `kind` was stamped for the current generation and `fingerprint`. */
export async function gateCounts(
  documents: DocumentRepository,
  run: RunEntity,
  kind: string,
  fingerprint: string,
): Promise<boolean> {
  return countsFor(run, await documents.latestStamp(run.key, kind), fingerprint);
}
