import type { RunEntity } from '../history/entities';
import type { DocumentRepository } from '../history/document.repository';
import type { RunRepository } from '../history/run.repository';
import type { Clock } from '../core/clock';
import { CHAT_LOCK, chatResume, lockRelease, readChatLock, shellLockFresh } from './chat-lock';

interface ContainerProbe {
  containerExists(name: string): Promise<boolean | null>;
}

/** Drop a shell lock whose container is already gone. An unanswered docker call keeps the lock. */
export async function settleShell(
  runs: RunRepository,
  documents: DocumentRepository,
  probe: ContainerProbe,
  run: RunEntity,
  clock: Clock,
): Promise<RunEntity> {
  const lock = readChatLock(await documents.latestBody(run.key, CHAT_LOCK));
  if (!lock?.container || run.status !== 'running') {
    return run;
  }
  if ((await probe.containerExists(lock.container)) !== false) {
    return run;
  }
  if (shellLockFresh(lock, clock.now())) {
    return run;
  }
  const saved = await runs.release(run, lockRelease(lock));
  await documents.putDocument(saved, CHAT_LOCK, 'clear\n');
  return saved;
}

/** Gives back a run whose chat process died: its status and reason come from the lock. True when it settled. */
export async function settleChat(
  runs: RunRepository,
  documents: DocumentRepository,
  run: RunEntity,
  body: string | null | undefined,
): Promise<boolean> {
  if (!chatResume(body, run.ownerPid)) {
    return false;
  }
  await runs.release(run, lockRelease(readChatLock(body)!));
  await documents.putDocument(run, CHAT_LOCK, 'clear\n');
  return true;
}

export function shellHolding(body: string | null | undefined, status: string): boolean {
  return status === 'running' && Boolean(readChatLock(body)?.container);
}
