import { basename } from 'path';
import { SandboxMount } from '../sandbox/sandbox-launch';
import { SwarmloopError } from '../swarmloop-error';
import { git, gitDetail } from './git';

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

/** Porcelain status plus the diff against HEAD, so two stamps match only when both are unchanged. */
export async function worktreeSnapshot(mounts: SandboxMount[]): Promise<string> {
  const status = await worktreeStatus(mounts);
  const diffs: string[] = [];
  for (const mount of mounts) {
    const repo = basename(mount.hostPath);
    diffs.push(await gitAt(mount.hostPath, repo, ['diff', 'HEAD'], 'status failed'));
  }
  return `${status}\n${diffs.join('\0')}`;
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
