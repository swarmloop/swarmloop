import { createHash } from 'crypto';
import { basename } from 'path';
import type { SandboxMount } from '../core/sandbox-mount';
import { SwarmloopError } from '../core/swarmloop-error';
import { git, gitDetail } from './git';
import { captureTree } from './worktree-tree';

export async function featureHeads(
  mounts: SandboxMount[],
  branch: string,
  detached: ReadonlySet<string> = new Set(),
): Promise<Map<string, string>> {
  const heads = new Map<string, string>();
  for (const mount of mounts) {
    const repo = basename(mount.hostPath);
    const current = await gitAt(mount.hostPath, repo, ['branch', '--show-current'], 'branch failed');
    if (current !== branch) {
      if (current === '' && detached.has(mount.hostPath)) {
        heads.set(mount.hostPath, await gitAt(mount.hostPath, repo, ['rev-parse', 'HEAD'], 'branch failed'));
        continue;
      }
      throw new SwarmloopError(`${repo} branch is missing`);
    }
    heads.set(mount.hostPath, await gitAt(mount.hostPath, repo, ['rev-parse', 'HEAD'], 'branch failed'));
  }
  return heads;
}

export async function assertUncommitted(
  mounts: SandboxMount[],
  branch: string,
  heads: Map<string, string>,
  moved: ReadonlySet<string> = new Set(),
): Promise<void> {
  for (const mount of mounts) {
    const repo = basename(mount.hostPath);
    const current = await gitAt(mount.hostPath, repo, ['branch', '--show-current'], 'branch failed');
    if (current !== branch) {
      throw new SwarmloopError(`${repo} branch changed`);
    }
    const head = await gitAt(mount.hostPath, repo, ['rev-parse', 'HEAD'], 'branch failed');
    if (head !== heads.get(mount.hostPath) && !moved.has(mount.hostPath)) {
      throw new SwarmloopError(`${repo} was committed`);
    }
  }
}

/**
 * Two stamps match only when every repository has the same HEAD and the same content, untracked files included.
 * `git diff HEAD` cannot see an edit inside a file git does not track yet, so the stamp is the tree of a temporary index.
 */
export async function worktreeSnapshot(mounts: SandboxMount[]): Promise<string> {
  const parts: string[] = [];
  for (const mount of mounts) {
    const repo = basename(mount.hostPath);
    const captured = await captureTree(mount.hostPath);
    if (captured) {
      parts.push(`${repo}\n${captured.head}\n${captured.tree}`);
      continue;
    }
    const status = await gitAt(mount.hostPath, repo, ['status', '--porcelain'], 'status failed');
    const diff = await gitAt(mount.hostPath, repo, ['diff', 'HEAD'], 'status failed');
    parts.push(`${repo}\n${status}\n${diff}`);
  }
  return parts.join('\0');
}

/**
 * What a journal and a gate record of the files they judged: the content of every worktree, untracked files included,
 * and not its HEAD, so committing the same files keeps it. A mount that is not a repository of its own adds only its name.
 */
export async function worktreeFingerprint(mounts: SandboxMount[]): Promise<string> {
  const parts: string[] = [];
  for (const mount of mounts) {
    const captured = await captureTree(mount.hostPath);
    parts.push(captured ? `${basename(mount.hostPath)}\n${captured.tree}` : basename(mount.hostPath));
  }
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

export async function worktreeStatus(mounts: SandboxMount[]): Promise<string> {
  const lines: string[] = [];
  for (const mount of mounts) {
    const repo = basename(mount.hostPath);
    const porcelain = await gitAt(mount.hostPath, repo, ['status', '--porcelain'], 'status failed');
    lines.push(porcelain ? `${repo}\n${porcelain}` : `${repo}\nclean`);
  }
  return lines.join('\n');
}

async function gitAt(path: string, repo: string, args: string[], failure: string): Promise<string> {
  try {
    return await git(['-C', path, ...args]);
  } catch (error) {
    throw new SwarmloopError(`${repo} ${failure}: ${gitDetail(error)}`);
  }
}
