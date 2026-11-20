import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { dirname, join, resolve } from 'path';
import type { HostClone } from './paths';
import { nestCheckout } from './paths';
import type { ServerApi } from './server-api';

/** The clone that holds a path on the host, read from its git files without a git process. */
export function readHostClone(path: string): HostClone | null {
  try {
    const top = findTop(path);
    const gitDir = top === null ? null : findGitDir(top);
    const origin = gitDir === null ? null : originOf(join(gitDir, 'config'));
    return top === null || origin === null ? null : { top, origin };
  } catch {
    return null;
  }
}

/** The path the server sees for a host path: its clone of the same project, or the real path. */
export async function serverPathOf(hostPath: string, api: ServerApi): Promise<string> {
  let real = hostPath;
  try {
    real = realpathSync(hostPath);
  } catch {
    // A path that cannot be resolved stays as given.
  }
  const hostClone = readHostClone(real);
  if (hostClone === null) {
    return real;
  }
  return nestCheckout(real, hostClone, (await api.cloneOrigins()).clones);
}

function findTop(path: string): string | null {
  let folder = resolve(path);
  for (;;) {
    if (existsSync(join(folder, '.git'))) {
      return folder;
    }
    const parent = dirname(folder);
    if (parent === folder) {
      return null;
    }
    folder = parent;
  }
}

function findGitDir(top: string): string | null {
  const dotGit = join(top, '.git');
  if (statSync(dotGit).isDirectory()) {
    return dotGit;
  }
  const link = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'));
  if (!link?.[1]) {
    return null;
  }
  const linked = resolve(top, link[1].trim());
  const common = join(linked, 'commondir');
  if (!existsSync(common)) {
    return linked;
  }
  return resolve(linked, readFileSync(common, 'utf8').trim());
}

function originOf(config: string): string | null {
  let inOrigin = false;
  for (const line of readFileSync(config, 'utf8').split('\n')) {
    const text = line.trim();
    if (text.startsWith('[')) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(text);
      continue;
    }
    const url = inOrigin ? /^url\s*=\s*(.+)$/.exec(text) : null;
    if (url?.[1]) {
      return url[1].trim();
    }
  }
  return null;
}
