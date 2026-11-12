import { lstatSync, readFileSync } from 'fs';
import { join } from 'path';
import type { SandboxMount } from '../../core/sandbox-mount';
import { runtimeFor } from '../../integrations/agent-runtime/agent-runtime.registry';
import { mountLabel } from './skill-prompt';

const RULE_FILE = 'AGENTS.md';
const MAX_BYTES = 32 * 1024;

function readRules(mount: SandboxMount): string | null {
  let bytes: Buffer;
  try {
    const file = join(mount.hostPath, RULE_FILE);
    // A symlink in a cloned repository could point at a host file the sandbox never sees.
    if (!lstatSync(file).isFile()) {
      return null;
    }
    bytes = readFileSync(file);
  } catch {
    return null;
  }
  const text = bytes.subarray(0, MAX_BYTES).toString('utf8').trimEnd();
  if (!text.trim()) {
    return null;
  }
  return bytes.length > MAX_BYTES
    ? `${text}\nThis file was cut at 32 KiB. The full file is ${mount.containerPath}/${RULE_FILE}.`
    : text;
}

/**
 * The `AGENTS.md` of each mounted repository, one section each. The CLI loads the file of the working directory (the
 * first mount) by itself when its runtime says so, and a chat that already got the sections gets none again.
 */
export function projectRules(
  names: string[],
  mounts: SandboxMount[],
  runtime: string,
  received: boolean,
): { heading: string; body: string }[] {
  if (received) {
    return [];
  }
  const loadedByCli = runtimeFor(runtime).ownRuleFiles().includes(RULE_FILE);
  return mounts.flatMap((mount, index) => {
    const body = index === 0 && loadedByCli ? null : readRules(mount);
    return body === null ? [] : [{ heading: `Project rules (${mountLabel(names, mount, index)})`, body }];
  });
}
