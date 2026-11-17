import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { copyFileSync, existsSync, realpathSync, rmSync, statSync, utimesSync } from 'fs';
import { tmpdir } from 'os';
import { basename, isAbsolute, join, resolve } from 'path';
import { rawEnv } from '../config/process-env';
import { delay } from '../core/delay';
import { SwarmloopError } from '../core/swarmloop-error';
import { GIT_LIMITS, git as recordedGit } from './git';

/** A git call that records no command span. It has a limit (a short one unless the caller names one), so a hung git ends as a failure. */
export function git(
  repo: string,
  args: string[],
  extra?: Record<string, string>,
  timeoutMs: number = GIT_LIMITS.query,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', repo, ...args],
      { env: { ...rawEnv(), ...extra }, timeout: timeoutMs },
      (error, stdout, stderr) => {
        if (error) {
          const { killed, signal } = error as { killed?: boolean; signal?: string };
          const timedOut = killed === true && signal === 'SIGTERM';
          reject(
            new Error(
              timedOut ? `git ${args[0]} timed out after ${timeoutMs / 1000} s` : (stderr || error.message).trim(),
            ),
          );
          return;
        }
        resolve(stdout);
      },
    );
  });
}

const NOT_A_REPOSITORY = 'not a git repository';
const PROBE_RETRY_MS = 1000;

/**
 * Runs a probe that records no event. Git's own "not a git repository" answer is null; any other failure is tried once
 * more after a pause and then thrown with git's text, so a slow or broken git is never read as "not a repository".
 */
async function probe(repo: string, args: string[]): Promise<string | null> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await git(repo, args);
    } catch (error) {
      if (error instanceof Error && error.message.includes(NOT_A_REPOSITORY)) {
        return null;
      }
      if (attempt > 1) {
        throw error;
      }
      await delay(PROBE_RETRY_MS);
    }
  }
}

async function isGitRepo(repo: string): Promise<boolean> {
  if (!existsSync(repo)) {
    return false;
  }
  return (await probe(repo, ['rev-parse', '--is-inside-work-tree']))?.trim() === 'true';
}

export async function ownsRepo(repo: string): Promise<boolean> {
  if (!(await isGitRepo(repo))) {
    return false;
  }
  const top = await probe(repo, ['rev-parse', '--show-toplevel']);
  return top !== null && realpathSync(top.trim()) === realpathSync(repo);
}

/** The tree of a worktree that must have one: no repository of its own is a failure with the path, never a null. */
export async function requireTree(repo: string): Promise<{ head: string; tree: string }> {
  const captured = await captureTree(repo);
  if (!captured) {
    throw new SwarmloopError(`${basename(repo)}: no git tree at ${repo}`);
  }
  return captured;
}

/** Index and HEAD stay put. The tree includes untracked files and skips ignored ones. A subdirectory of a repository is not rewound. */
export async function captureTree(repo: string): Promise<{ head: string; tree: string } | null> {
  if (!(await ownsRepo(repo))) {
    return null;
  }
  const query = (args: string[], env?: NodeJS.ProcessEnv, timeoutMs: number = GIT_LIMITS.snapshot) =>
    recordedGit(['-C', repo, ...args], env, { timeoutMs });
  let head = '';
  try {
    head = await query(['rev-parse', 'HEAD'], undefined, GIT_LIMITS.query);
  } catch {
    head = '';
  }
  const index = join(tmpdir(), `swarmloop-index-${randomBytes(8).toString('hex')}`);
  try {
    await seedIndex(repo, index, query);
    const env = { GIT_INDEX_FILE: index };
    await query(['add', '-A'], env);
    const tree = await query(['write-tree'], env);
    return { head, tree };
  } finally {
    rmSync(index, { force: true });
    rmSync(`${index}.lock`, { force: true });
  }
}

/**
 * Starts the temporary index as a copy of the worktree's own, so `add -A` hashes only what changed. No index file means
 * an empty one. The copy keeps the index's own modification time: git re-reads every entry changed in or after the
 * second the index was written ("racy git"), and a fresh time on the copy would hide an edit of the same size.
 */
async function seedIndex(
  repo: string,
  index: string,
  query: (args: string[], env?: NodeJS.ProcessEnv, timeoutMs?: number) => Promise<string>,
): Promise<void> {
  const own = await query(['rev-parse', '--git-path', 'index'], undefined, GIT_LIMITS.query);
  const path = isAbsolute(own) ? own : resolve(repo, own);
  if (existsSync(path)) {
    copyFileSync(path, index);
    const { atime, mtime } = statSync(path);
    utimesSync(index, atime, mtime);
  }
}
