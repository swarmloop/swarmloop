import type { SandboxMount } from '../core/sandbox-mount';
import { SwarmloopError } from '../core/swarmloop-error';
import { baseBranch, originRef } from './base-ref';
import { isDenied } from './commit-paths';
import { gitMissing, gitRaw } from './git';

/**
 * The files of a worktree's change against its base, as the review reads it: the merge-base diff names plus the
 * untracked files, denied paths left out. Null when the change cannot be read: not a git checkout, or no base ref or
 * merge-base.
 */
export async function changeFiles(
  mount: SandboxMount,
  prompt: string | null,
  denied: string[] = [],
): Promise<string[] | null> {
  const cwd = mount.hostPath;
  if (!(await inside(cwd))) {
    return null;
  }
  const base = await baseRef(cwd, baseBranch(prompt));
  const mergeBase = base ? ((await optional(cwd, ['merge-base', base, 'HEAD']))?.trim() ?? '') : '';
  if (!base || !mergeBase) {
    return null;
  }
  const tracked = splitLines(await optional(cwd, ['diff', '--name-only', mergeBase]));
  const untracked = splitLines(await optional(cwd, ['ls-files', '--others', '--exclude-standard']));
  return [...tracked, ...untracked].filter((path) => !isDenied(path, denied));
}

export function splitLines(text: string | null): string[] {
  return (text ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.includes('..'));
}

export async function inside(cwd: string): Promise<boolean> {
  try {
    return (
      (
        await gitRaw(['-C', cwd, 'rev-parse', '--is-inside-work-tree'], undefined, undefined, { answers: [128] })
      ).trim() === 'true'
    );
  } catch {
    return false;
  }
}

export async function baseRef(cwd: string, named: string | null): Promise<string | null> {
  if (named) {
    return (await hasRef(cwd, originRef(named))) ? originRef(named) : null;
  }
  if (await hasRef(cwd, 'origin/main')) {
    return 'origin/main';
  }
  if (await hasRef(cwd, 'origin/master')) {
    return 'origin/master';
  }
  return null;
}

async function hasRef(cwd: string, ref: string): Promise<boolean> {
  try {
    return (
      (
        await gitRaw(['-C', cwd, 'rev-parse', '--verify', '--quiet', ref], undefined, undefined, { answers: [1] })
      ).trim().length > 0
    );
  } catch {
    return false;
  }
}

export async function optional(cwd: string, args: string[], answers?: number[]): Promise<string | null> {
  try {
    return await gitRaw(['-C', cwd, ...args], undefined, undefined, { answers });
  } catch (error) {
    if (isOutputCap(error)) {
      throw new SwarmloopError('git diff is too large to read');
    }
    const stdout = stdoutOf(error);
    if (gitMissing(error) && stdout.length > 0) {
      return stdout;
    }
    return null;
  }
}

function isOutputCap(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
  );
}

function stdoutOf(error: unknown): string {
  if (typeof error === 'object' && error !== null && 'stdout' in error && typeof error.stdout === 'string') {
    return error.stdout;
  }
  return '';
}
