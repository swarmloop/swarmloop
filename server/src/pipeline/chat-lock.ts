import type { StateReason } from '../contract/run-state';

export const CHAT_LOCK = 'chat_lock';

const PID_LOCK = /^(waiting|blocked|failed|done) (\d+)$/;
const CONTAINER_LOCK = /^(waiting|blocked|failed|done) container ([a-z0-9][a-z0-9_.-]+)(?: (\d+))?$/;
const START_GRACE_MS = 10_000;

interface ChatLock {
  status: string;
  pid?: number;
  container?: string;
  since?: number;
  /** The stored reason the hold took. Left out of a body written without one. */
  reason?: StateReason;
}

function reasonLine(reason: StateReason | null | undefined): string {
  return reason ? `${JSON.stringify(reason)}\n` : '';
}

export function chatLockBody(status: string, pid: number, reason?: StateReason | null): string {
  return `${status} ${pid}\n${reasonLine(reason)}`;
}

export function containerLockBody(status: string, container: string, now: number, reason?: StateReason | null): string {
  return `${status} container ${container} ${now}\n${reasonLine(reason)}`;
}

function readReason(line: string | undefined): StateReason | undefined {
  if (!line?.trim()) {
    return undefined;
  }
  try {
    return JSON.parse(line) as StateReason;
  } catch {
    return undefined;
  }
}

/** The change that gives a run back what a lock took: its status and its stored reason. */
export function lockRelease(lock: ChatLock): { status: string; reason: StateReason | null } {
  return { status: lock.status, reason: lock.reason ?? null };
}

export function readChatLock(body: string | null | undefined): ChatLock | null {
  const [first, second] = (body ?? '').trim().split('\n');
  const text = first.trim();
  const reason = readReason(second);
  const container = CONTAINER_LOCK.exec(text);
  if (container) {
    const parsed: ChatLock = { status: container[1], container: container[2] };
    if (container[3] !== undefined) {
      parsed.since = Number(container[3]);
    }
    return reason ? { ...parsed, reason } : parsed;
  }
  const pid = PID_LOCK.exec(text);
  if (!pid) {
    return null;
  }
  const parsed: ChatLock = { status: pid[1], pid: Number(pid[2]) };
  return reason ? { ...parsed, reason } : parsed;
}

function ownerAlive(pid: number | null): boolean {
  if (pid === null || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Status to put back when the process died during a chat. A container lock is settled by the sandbox, not by a pid. */
export function chatResume(body: string | null | undefined, ownerPid: number | null): string | null {
  const lock = readChatLock(body);
  if (!lock || lock.container || lock.pid !== ownerPid || ownerAlive(ownerPid)) {
    return null;
  }
  return lock.status;
}

/** True while a chat, not a pipeline step, owns the running row. */
export function chatHeld(body: string | null | undefined, status: string, ownerPid: number | null): boolean {
  const lock = readChatLock(body);
  if (status !== 'running' || lock === null) {
    return false;
  }
  if (lock.container) {
    return true;
  }
  return lock.pid === ownerPid;
}

/** A missing container in the first moments is the sandbox still starting, not a dead session. */
export function shellLockFresh(lock: ChatLock, now: number): boolean {
  return lock.since !== undefined && now - lock.since < START_GRACE_MS;
}
