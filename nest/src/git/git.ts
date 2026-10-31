import { execFile } from 'child_process';
import { realpathSync } from 'fs';
import { isAbsolute, join, resolve, sep } from 'path';
import { SwarmloopError } from '../swarmloop-error';

export function git(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return gitText(args, env).then((stdout) => stdout.trim());
}

export function gitRaw(args: string[], env?: NodeJS.ProcessEnv, input?: string): Promise<string> {
  return gitText(args, env, input);
}

const GIT_OUTPUT_CAP = 64_000_000;

function gitText(args: string[], extra?: NodeJS.ProcessEnv, input?: string): Promise<string> {
  const command = withSafeDirectory(args, checkoutRoots());
  const env = extra ? { ...process.env, ...extra } : undefined;
  return new Promise((done, fail) => {
    const child = execFile(
      'git',
      command,
      {
        encoding: 'utf8',
        timeout: 600_000,
        maxBuffer: GIT_OUTPUT_CAP,
        env,
        ...(input === undefined ? {} : { stdio: ['pipe', 'pipe', 'pipe'] as ['pipe', 'pipe', 'pipe'] }),
      },
      (error, stdout, stderr) => {
        if (error) {
          if (typeof stdout === 'string' && stdout.length > 0) {
            (error as { stdout?: string }).stdout = stdout;
          }
          if (typeof stderr === 'string' && stderr.length > 0) {
            (error as { stderr?: string }).stderr = stderr;
          }
          fail(error);
          return;
        }
        done(stdout);
      },
    );
    if (input !== undefined && child.stdin) {
      child.stdin.on('error', () => undefined);
      child.stdin.end(input);
    }
  });
}

export function gitMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error as { code?: unknown }).code === 1;
}

/** Trust this checkout only. A root process otherwise refuses a developer-owned .git. */
export function withSafeDirectory(args: string[], roots: readonly string[]): string[] {
  const directory = directoryArg(args);
  if (!directory) {
    return args;
  }
  const canonical = canonicalPath(directory);
  if (!canonical || !roots.some((root) => contains(root, canonical))) {
    return args;
  }
  return ['-c', `safe.directory=${canonical}`, ...args];
}

function checkoutRoots(): string[] {
  const worktrees = process.env.SWARMLOOP_ROOT ? join(process.env.SWARMLOOP_ROOT, 'worktrees') : '';
  return [process.env.CHECKOUTS_ROOT ?? '', worktrees].filter((root) => isAbsolute(root));
}

function directoryArg(args: string[]): string | null {
  const index = args.indexOf('-C');
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && value.length > 0 ? value : null;
}

function canonicalPath(directory: string): string | null {
  try {
    return realpathSync(isAbsolute(directory) ? directory : resolve(directory));
  } catch {
    return null;
  }
}

function contains(root: string, directory: string): boolean {
  const canonical = canonicalPath(root);
  if (!canonical) {
    return false;
  }
  const prefix = canonical.endsWith(sep) ? canonical : `${canonical}${sep}`;
  return directory === canonical || directory.startsWith(prefix);
}

/** Full git stderr, or one preferred line when git left stderr empty. */
export function gitStderr(error: unknown): string {
  const record = error && typeof error === 'object' ? (error as { stderr?: unknown }) : {};
  const stderr = String(record.stderr ?? '').trim();
  return stderr || gitDetail(error);
}

export function gitDetail(error: unknown): string {
  const record = error && typeof error === 'object' ? (error as { stderr?: unknown; stdout?: unknown; message?: unknown }) : {};
  const stderr = String(record.stderr ?? '');
  const stdout = String(record.stdout ?? '');
  const message = typeof record.message === 'string' ? record.message : '';
  const lines = `${stderr}\n${stdout}\n${message}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('Command failed:'));
  const remote = lines.find((line) => line.includes('remote rejected') || line.startsWith('remote: GitLab'));
  const fatal = lines.find((line) => (line.startsWith('fatal:') || line.startsWith('error:')) && !line.includes('failed to push some refs'));
  const generic = lines.find((line) => line.startsWith('fatal:') || line.startsWith('error:'));
  return (remote ?? fatal ?? generic ?? lines[0] ?? 'git failed').slice(0, 400);
}

export async function authorArgs(cwd: string): Promise<string[]> {
  try {
    const email = (await git(['-C', cwd, 'config', '--local', '--get', 'user.email'])).trim();
    if (email) {
      return [];
    }
  } catch {
    // Fall through to the environment author used by commit.
  }
  const name = process.env.GIT_AUTHOR_NAME?.trim() ?? '';
  const email = process.env.GIT_AUTHOR_EMAIL?.trim() ?? '';
  if (!name || !email) {
    return [];
  }
  return ['-c', `user.name=${name}`, '-c', `user.email=${email}`];
}

export async function originUrl(cwd: string, repo: string, failure: string): Promise<string | null> {
  try {
    const url = (await git(['-C', cwd, 'remote', 'get-url', 'origin'])).trim();
    return url || null;
  } catch (error) {
    if (gitDetail(error).includes('No such remote')) {
      return null;
    }
    throw new SwarmloopError(`${repo} ${failure}: ${gitDetail(error)}`);
  }
}

export function redact(detail: string, secret?: string): string {
  if (!secret) {
    return detail;
  }
  return detail.split(secret).join('***').split(encodeURIComponent(secret)).join('***');
}
