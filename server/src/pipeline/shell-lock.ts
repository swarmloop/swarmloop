import type { RunEntity } from '../history/entities';
import type { DocumentRepository } from '../history/document.repository';
import type { RunRepository } from '../history/run.repository';
import type { Clock } from '../core/clock';
import { CHAT_LOCK, readChatLock, shellLockFresh } from './chat-lock';

export interface ContainerProbe {
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
  run.status = lock.status;
  run.ownerPid = null;
  const saved = await runs.saveRun(run);
  await documents.putDocument(saved, CHAT_LOCK, 'clear\n');
  return saved;
}

export function shellHolding(body: string | null | undefined, status: string): boolean {
  return status === 'running' && Boolean(readChatLock(body)?.container);
}
