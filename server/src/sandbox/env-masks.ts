import { existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { ignoredDirectories, isCheckout, trackedFiles } from '../git/ignored-entries';
import type { EnvMask } from './sandbox-launch';

export function collectEnvMasks(mounts: { hostPath: string; containerPath: string }[]): EnvMask[] {
  const masks: EnvMask[] = [];
  for (const mount of mounts) {
    if (mount.containerPath.endsWith('/.git') || mount.containerPath.startsWith('/swarmloop-git/')) {
      continue;
    }
    walkEnv(mount.hostPath, mount.containerPath, masks, gitRules(mount.hostPath));
  }
  return masks;
}

/** What git says about a checkout: the ignored directories and the tracked files, as paths from its root. */
interface GitRules {
  ignored: Set<string>;
  tracked: Set<string>;
}

/** Null outside a checkout, or when git fails: the walk then masks every env file but the example. */
function gitRules(host: string): GitRules | null {
  if (!isCheckout(host)) {
    return null;
  }
  try {
    return { ignored: ignoredDirectories(host), tracked: trackedFiles(host) };
  } catch {
    return null;
  }
}

function walkEnv(host: string, container: string, masks: EnvMask[], rules: GitRules | null, relativePath = ''): void {
  if (!existsSync(host) || !statSync(host).isDirectory()) {
    return;
  }
  for (const entry of readdirSync(host, { withFileTypes: true })) {
    if (entry.name === '.git') {
      continue;
    }
    const hostPath = join(host, entry.name);
    const containerFile = `${container}/${entry.name}`;
    const entryPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!rules?.ignored.has(entryPath)) {
        walkEnv(hostPath, containerFile, masks, rules, entryPath);
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
