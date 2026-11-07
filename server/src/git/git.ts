import { execFile } from 'child_process';
import { realpathSync } from 'fs';
import { basename, isAbsolute, join, resolve, sep } from 'path';
import { rawEnv } from '../config/process-env';
import { startCommandSpan } from '../core/step-event-scope';
import { SwarmloopError } from '../core/swarmloop-error';

export function git(args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return gitText(args, env).then((stdout) => stdout.trim());
}

export function gitRaw(args: string[], env?: NodeJS.ProcessEnv, input?: string): Promise<string> {
  return gitText(args, env, input);
}

const GIT_OUTPUT_CAP = 64_000_000;

function gitText(args: string[], extra?: NodeJS.ProcessEnv, input?: string): Promise<string> {
  const command = withSafeDirectory(args, checkoutRoots());
  const env = extra ? { ...rawEnv(), ...extra } : undefined;
  const directory = directoryArg(args);
  const finish = startCommandSpan({
    actor: 'server',
    repo: directory ? basename(directory) : '',
    cwd: directory ? resolve(directory) : process.cwd(),
    executable: 'git',
    args,
  });
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
      (error: unknown, stdout, stderr) => {
        finish({ ...commandOutcome(error), output: `${stdout}${stderr}` });
        if (error) {
          const message =
            typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string'
              ? error.message
              : 'Git command failed';
          const failure = error instanceof Error ? error : new Error(message);
          if (typeof error === 'object' && error !== null && 'code' in error) {
            (failure as { code?: unknown }).code = error.code;
          }
          if (typeof stdout === 'string' && stdout.length > 0) {
            Object.assign(failure, { stdout });
          }
          if (typeof stderr === 'string' && stderr.length > 0) {
            Object.assign(failure, { stderr });
          }
          fail(failure);
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

/** How a git process ended. The timeout is the only thing that kills it on purpose, so another signal is a cancel. */
function commandOutcome(error: unknown): {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
} {
  if (!error) {
    return { exitCode: 0, signal: null, timedOut: false, cancelled: false };
  }
  const { code, signal, killed } = error as { code?: unknown; signal?: unknown; killed?: unknown };
  const signalName = typeof signal === 'string' ? signal : null;
  return {
    exitCode: typeof code === 'number' ? code : null,
    signal: signalName,
    timedOut: killed === true,
    cancelled: signalName !== null && killed !== true,
  };
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
  const env = rawEnv();
  const worktrees = env.SWARMLOOP_ROOT ? join(env.SWARMLOOP_ROOT, 'worktrees') : '';
  return [env.CHECKOUTS_ROOT ?? '', worktrees].filter((root) => isAbsolute(root));
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
  const stderr = (typeof record.stderr === 'string' ? record.stderr : '').trim();
  return stderr || gitDetail(error);
}

export function gitDetail(error: unknown): string {
  const record =
    error && typeof error === 'object' ? (error as { stderr?: unknown; stdout?: unknown; message?: unknown }) : {};
  const stderr = typeof record.stderr === 'string' ? record.stderr : '';
  const stdout = typeof record.stdout === 'string' ? record.stdout : '';
  const message = typeof record.message === 'string' ? record.message : '';
  const lines = `${stderr}\n${stdout}\n${message}`
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('Command failed:'));
  const remote = lines.find((line) => line.includes('remote rejected') || line.startsWith('remote: GitLab'));
  const fatal = lines.find(
    (line) => (line.startsWith('fatal:') || line.startsWith('error:')) && !line.includes('failed to push some refs'),
  );
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
  const env = rawEnv();
  const name = env.GIT_AUTHOR_NAME?.trim() ?? '';
  const email = env.GIT_AUTHOR_EMAIL?.trim() ?? '';
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
