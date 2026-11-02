export const CHAT_LOCK = 'chat_lock';

const PID_LOCK = /^(waiting|blocked|failed|done) (\d+)$/;
const CONTAINER_LOCK = /^(waiting|blocked|failed|done) container ([a-z0-9][a-z0-9_.-]+)(?: (\d+))?$/;
const START_GRACE_MS = 10_000;

export interface ChatLock {
  status: string;
  pid?: number;
  container?: string;
  since?: number;
}

export function chatLockBody(status: string, pid: number): string {
  return `${status} ${pid}\n`;
}

export function containerLockBody(status: string, container: string, now = Date.now()): string {
  return `${status} container ${container} ${now}\n`;
}

export function readChatLock(body: string | null | undefined): ChatLock | null {
  const text = (body ?? '').trim();
  const container = CONTAINER_LOCK.exec(text);
  if (container) {
    const parsed: ChatLock = { status: container[1], container: container[2] };
    if (container[3] !== undefined) {
      parsed.since = Number(container[3]);
    }
    return parsed;
  }
  const pid = PID_LOCK.exec(text);
  if (!pid) {
    return null;
  }
  return { status: pid[1], pid: Number(pid[2]) };
}

export function ownerAlive(pid: number | null): boolean {
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
