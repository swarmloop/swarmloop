import type { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import { worktreeFingerprint } from '../../git/worktree-git';
import { countsFor } from '../../history/gate-stamp';

/** The fingerprint of the worktrees at these paths, in one order whoever asks. */
export function worktreesFingerprint(hostPaths: string[]): Promise<string> {
  return worktreeFingerprint([...hostPaths].sort().map((hostPath) => ({ hostPath, containerPath: '/work' })));
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
