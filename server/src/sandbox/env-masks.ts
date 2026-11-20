import { closeSync, existsSync, mkdirSync, openSync } from 'fs';
import { readdir, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { ignoredDirectories, isCheckout, trackedFiles } from '../git/ignored-entries';
import type { EnvMask } from './sandbox-launch';

export async function collectEnvMasks(mounts: { hostPath: string; containerPath: string }[]): Promise<EnvMask[]> {
  const masks: EnvMask[] = [];
  for (const mount of mounts) {
    if (mount.containerPath.endsWith('/.git') || mount.containerPath.startsWith('/swarmloop-git/')) {
      continue;
    }
    await walkEnv(mount.hostPath, mount.containerPath, masks, await gitRules(mount.hostPath));
  }
  return masks;
}

export function ensureMaskFile(path: string): void {
  if (existsSync(path)) {
    return;
  }
  mkdirSync(tmpdir(), { recursive: true });
  closeSync(openSync(path, 'a'));
}

/** What git says about a checkout: the ignored directories and the tracked files, as paths from its root. */
interface GitRules {
  ignored: Set<string>;
  tracked: Set<string>;
}

/** Null outside a checkout, or when git fails: the walk then masks every env file but the example. */
async function gitRules(host: string): Promise<GitRules | null> {
  if (!isCheckout(host)) {
    return null;
  }
  try {
    return { ignored: await ignoredDirectories(host), tracked: await trackedFiles(host) };
  } catch {
    return null;
  }
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function walkEnv(
  host: string,
  container: string,
  masks: EnvMask[],
  rules: GitRules | null,
  relativePath = '',
): Promise<void> {
  if (!(await isDirectory(host))) {
    return;
  }
  for (const entry of await readdir(host, { withFileTypes: true })) {
    if (entry.name === '.git') {
      continue;
    }
    const hostPath = join(host, entry.name);
    const containerFile = `${container}/${entry.name}`;
    const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!rules?.ignored.has(entryPath)) {
        await walkEnv(hostPath, containerFile, masks, rules, entryPath);
      }
      continue;
    }
    const envFile = entry.name === '.env' || entry.name.startsWith('.env.');
    const kept = rules ? rules.tracked.has(entryPath) : entry.name === '.env.example';
    if (envFile && !kept) {
      masks.push({ hostFile: hostPath, containerFile });
    }
  }
}
