import type { DataSource } from 'typeorm';
import type { AgentCallRepository } from './agent-call.repository';
import { seedPastPing } from './past-ping.spec-helpers';

const AT = '2026-11-26T10:00:00.000Z';

/** What a seeded row of the log holds. The usd and the tokens land on the row as one model request. */
export interface SeededCall {
  runKey: string;
  step?: string;
  attemptId?: string;
  usd?: number;
  /** The four kinds of token of the row, in this order of the contract. */
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
  output?: number;
  /** The stored visit the row is linked to; unlinked when left out. */
  statId?: number;
  chatId?: string;
}

let nextChat = 0;

const COMMON = { startedAt: AT, runtime: 'claude', model: 'claude-opus-5-5', requestText: 'ask' };

/** Counts, ends and links an opened row as the launcher does, and returns its id. */
async function settle(log: AgentCallRepository, id: number, call: SeededCall): Promise<number> {
  await log.addRequest(id, {
    model: COMMON.model,
    input: call.input ?? 0,
    cacheRead: call.cacheRead ?? 0,
    cacheWrite: call.cacheWrite ?? 0,
    output: call.output ?? 0,
    usd: call.usd ?? 0,
    price: {},
  });
  await log.finish(id, { endKind: 'done', finishedAt: AT, durationMs: 1000, responseText: 'ok' });
  if (call.statId !== undefined) {
    await log.linkVisit([id], call.statId);
  }
  return id;
}

/** Writes one finished row of the log through its repository, as the launcher writes it, and returns its id. */
export async function seedCall(log: AgentCallRepository, call: SeededCall): Promise<number> {
  const id = await log.open({
    ...COMMON,
    kind: 'call',
    resumed: false,
    runKey: call.runKey,
    step: call.step ?? 'implement',
    chatId: call.chatId ?? `chat-${(nextChat += 1)}`,
    ...(call.attemptId ? { attemptId: call.attemptId } : {}),
  });
  return settle(log, id, call);
}

/** Writes one finished row of a keep-warm ping, which the product no longer writes, and returns its id. */
export async function seedPingCall(data: DataSource, log: AgentCallRepository, call: SeededCall): Promise<number> {
  const chatId = call.chatId ?? `chat-${(nextChat += 1)}`;
  const id = await seedPastPing(data, {
    startedAt: AT,
    chatId,
    previousId: 0,
    runKey: call.runKey,
    dueAt: `due-${chatId}`,
    ...(call.step ? { step: call.step } : {}),
  });
  return settle(log, id, call);
}
