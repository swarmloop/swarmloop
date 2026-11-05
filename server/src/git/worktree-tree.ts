import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { rawEnv } from '../config/process-env';

export function git(repo: string, args: string[], extra?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repo, ...args], { env: { ...rawEnv(), ...extra } }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).trim()));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function isGitRepo(repo: string): Promise<boolean> {
  try {
    return (await git(repo, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

export async function ownsRepo(repo: string): Promise<boolean> {
  if (!(await isGitRepo(repo))) {
    return false;
  }
  try {
    const top = (await git(repo, ['rev-parse', '--show-toplevel'])).trim();
    return realpathSync(top) === realpathSync(repo);
  } catch {
    return false;
  }
}

/** Index and HEAD stay put. The tree includes untracked files and skips ignored ones. A subdirectory of a repository is not rewound. */
export async function captureTree(repo: string): Promise<{ head: string; tree: string } | null> {
  if (!(await ownsRepo(repo))) {
    return null;
  }
  let head = '';
  try {
    head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  } catch {
    head = '';
  }
  const index = join(tmpdir(), `swarmloop-index-${randomBytes(8).toString('hex')}`);
  try {
    const env = { GIT_INDEX_FILE: index };
    await git(repo, ['add', '-A'], env);
    const tree = (await git(repo, ['write-tree'], env)).trim();
    return { head, tree };
  } finally {
    rmSync(index, { force: true });
    rmSync(`${index}.lock`, { force: true });
  }
}
