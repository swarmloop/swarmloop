import { RunEntity } from '../history/entities';
import { HistoryService } from '../history/history.service';
import { CHAT_LOCK, readChatLock, shellLockFresh } from './chat-lock';

export interface ContainerProbe {
  containerExists(name: string): Promise<boolean | null>;
}

/** Drop a shell lock whose container is already gone. An unanswered docker call keeps the lock. */
export async function settleShell(history: HistoryService, probe: ContainerProbe, run: RunEntity): Promise<RunEntity> {
  const lock = readChatLock(await history.latestBody(run.key, CHAT_LOCK));
  if (!lock?.container || run.status !== 'running') {
    return run;
  }
  if ((await probe.containerExists(lock.container)) !== false) {
    return run;
  }
  if (shellLockFresh(lock, Date.now())) {
    return run;
  }
  run.status = lock.status;
  run.ownerPid = null;
  const saved = await history.saveRun(run);
  await history.putDocument(saved, CHAT_LOCK, 'clear\n');
  return saved;
}

export function shellHolding(body: string | null | undefined, status: string): boolean {
  return status === 'running' && Boolean(readChatLock(body)?.container);
}
