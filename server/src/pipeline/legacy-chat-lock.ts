import type { StateReason } from '../contract/run-state';
import type { DocumentRepository } from '../history/document.repository';
import type { RunEntity } from '../history/entities';
import type { RunRepository } from '../history/run.repository';
import { containerName } from '../sandbox/sandbox-launch';
import type { SandboxService } from '../sandbox/sandbox.service';

const LOCK_KIND = 'chat_lock';
const PID_LOCK = /^(waiting|blocked|failed|done) (\d+)$/;
const CONTAINER_LOCK = /^(waiting|blocked|failed|done) container ([a-z0-9][a-z0-9_.-]+)(?: \d+)?$/;

interface LegacyLock {
  status: string;
  container?: string;
  pid?: number;
  reason: StateReason | null;
}

function parseReason(line: string | undefined): StateReason | null {
  if (!line?.trim()) {
    return null;
  }
  try {
    return JSON.parse(line) as StateReason;
  } catch {
    return null;
  }
}

/** Reads a lock body that a former version wrote: `<status> <pid>` or `<status> container <name> [<since>]`, then an optional reason. */
function parseLegacyLock(body: string | null): LegacyLock | null {
  const [first = '', second] = (body ?? '').trim().split('\n');
  const text = first.trim();
  const container = CONTAINER_LOCK.exec(text);
  if (container) {
    return { status: container[1], container: container[2], reason: parseReason(second) };
  }
  const pid = PID_LOCK.exec(text);
  return pid ? { status: pid[1], pid: Number(pid[2]), reason: parseReason(second) } : null;
}

/**
 * Gives back a run that a lock written by a former version still holds: the run's own shell container it names is removed, the run
 * gets the status and reason the lock stored, and the lock is cleared. True when it released the run.
 */
export async function releaseLegacyChatLock(
  runs: RunRepository,
  documents: DocumentRepository,
  sandbox: SandboxService,
  run: RunEntity,
): Promise<boolean> {
  const lock = parseLegacyLock(await documents.latestBody(run.key, LOCK_KIND));
  if (!lock || run.status !== 'running') {
    return false;
  }
  // A pid lock held the run only while its pid was the run's owner; an older leftover holds nothing.
  if (lock.pid !== undefined && lock.pid !== run.ownerPid) {
    return false;
  }
  // The name was stored from a request: only the run's own shell container is removed.
  if (lock.container === containerName(run.key, 'shell')) {
    await sandbox.remove(lock.container);
  }
  const saved = await runs.release(run, { status: lock.status, reason: lock.reason });
  await documents.putDocument(saved, LOCK_KIND, 'clear\n');
  return true;
}
