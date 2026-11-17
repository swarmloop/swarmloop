import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import { rawEnv } from '../config/process-env';

export const NOT_SIGNED_IN = 'sign in first: run `sloop login` or set SWARMLOOP_TOKEN';

export function configPath(env: NodeJS.ProcessEnv = rawEnv(), home: string = homedir()): string {
  const base = env.XDG_CONFIG_HOME ? env.XDG_CONFIG_HOME : join(home, '.config');
  return join(base, 'swarmloop', 'cli.json');
}

export function readFileToken(file: string): string | null {
  if (!existsSync(file)) {
    return null;
  }
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as { token?: unknown };
    return typeof parsed.token === 'string' && parsed.token !== '' ? parsed.token : null;
  } catch {
    return null;
  }
}

export function writeFileToken(file: string, token: string): void {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${JSON.stringify({ token })}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

export function deleteFileToken(file: string): void {
  rmSync(file, { force: true });
}

/** The token the CLI acts with: SWARMLOOP_TOKEN, else the file `sloop login` wrote, else none. */
export function tokenSource(env: NodeJS.ProcessEnv = rawEnv(), home: string = homedir()): string | null {
  const fromEnv = env.SWARMLOOP_TOKEN;
  if (fromEnv) {
    return fromEnv;
  }
  return readFileToken(configPath(env, home));
}
