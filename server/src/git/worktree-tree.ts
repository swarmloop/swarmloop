import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { copyFileSync, existsSync, realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { isAbsolute, join, resolve } from 'path';
import { rawEnv } from '../config/process-env';
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

const TIMED_OUT = ' timed out after ';

async function isGitRepo(repo: string): Promise<boolean> {
  try {
    return (await git(repo, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch (error) {
    throwTimeout(error);
    return false;
  }
}

/** Any failure of these probes means "not a repository", except a timeout: that is a failure to report. */
function throwTimeout(error: unknown): void {
  if (error instanceof Error && error.message.includes(TIMED_OUT)) {
    throw error;
  }
}

export async function ownsRepo(repo: string): Promise<boolean> {
  if (!(await isGitRepo(repo))) {
    return false;
  }
  try {
    const top = (await git(repo, ['rev-parse', '--show-toplevel'])).trim();
    return realpathSync(top) === realpathSync(repo);
  } catch (error) {
    throwTimeout(error);
    return false;
  }
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

/** Starts the temporary index as a copy of the worktree's own, so `add -A` hashes only what changed. No index file means an empty one. */
async function seedIndex(
  repo: string,
  index: string,
  query: (args: string[], env?: NodeJS.ProcessEnv, timeoutMs?: number) => Promise<string>,
): Promise<void> {
  const own = await query(['rev-parse', '--git-path', 'index'], undefined, GIT_LIMITS.query);
  const path = isAbsolute(own) ? own : resolve(repo, own);
  if (existsSync(path)) {
    copyFileSync(path, index);
  }
}
