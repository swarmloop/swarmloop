import type { CallEnd, CallStart, ModelPrice } from './agent-call';
import type { AgentCallRepository } from './agent-call.repository';

export const PRICE: ModelPrice = { cacheReadPerMillion: 0.2, cacheWritePerMillion: 8 };

/** A time on 2026-11-26 (UTC). */
export function at(hour: number, minute = 0): string {
  return `2026-11-26T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
}

interface Seeded {
  start: Partial<CallStart>;
  usd?: number;
  cacheRead?: number;
  cacheWrite?: number;
  end?: Partial<CallEnd>;
  ties?: { task?: string; epic?: string; general: boolean }[];
}

/** Writes one call through the repository's own writes: opened, counted, ended. */
export async function seedCall(log: AgentCallRepository, seeded: Seeded): Promise<number> {
  const startedAt = seeded.start.startedAt ?? at(10);
  const id = await log.open({
    kind: 'call',
    startedAt,
    resumed: false,
    runtime: 'claude',
    model: 'claude-opus-5-5',
    requestText: 'go',
    ...seeded.start,
  });
  await log.addRequest(id, {
    model: seeded.start.model ?? 'claude-opus-5-5',
    input: 0,
    cacheRead: seeded.cacheRead ?? 0,
    cacheWrite: seeded.cacheWrite ?? 0,
    output: 0,
    usd: seeded.usd ?? 0,
    price: PRICE,
  });
  if (seeded.ties) {
    await log.setTies(id, seeded.ties);
  }
  await log.finish(id, {
    endKind: 'done',
    finishedAt: startedAt,
    durationMs: 0,
    responseText: 'ok',
    ...seeded.end,
  });
  return id;
}

/** Writes one ping on a chat through `insertPing`, counted and ended. */
export async function seedPing(
  log: AgentCallRepository,
  ping: {
    chatId: string;
    previousId: number;
    startedAt: string;
    usd: number;
    cacheRead?: number;
    cacheWrite?: number;
    end?: CallEnd['endKind'];
    taskSlug?: string;
  },
): Promise<number> {
  const id = await log.insertPing({
    startedAt: ping.startedAt,
    dueAt: ping.startedAt,
    chatId: ping.chatId,
    previousId: ping.previousId,
    runKey: 'run-1',
    taskSlug: ping.taskSlug,
    runtime: 'claude',
    model: 'claude-opus-5-5',
    requestText: 'ping',
  });
  if (id === null) {
    throw new Error('the ping was already written');
  }
  await log.addRequest(id, {
    model: 'claude-opus-5-5',
    input: 0,
    cacheRead: ping.cacheRead ?? 0,
    cacheWrite: ping.cacheWrite ?? 0,
    output: 0,
    usd: ping.usd,
    price: PRICE,
  });
  await log.finish(id, { endKind: ping.end ?? 'done', finishedAt: ping.startedAt, durationMs: 0, responseText: 'ok' });
  return id;
}
