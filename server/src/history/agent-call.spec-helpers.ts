import type { AgentCallRepository } from './agent-call.repository';

const AT = '2026-11-26T10:00:00.000Z';

/** What a seeded row of the log holds. The usd and the tokens land on the row as one model request. */
export interface SeededCall {
  runKey: string;
  step?: string;
  attemptId?: string;
  /** Seeds a keep-warm ping instead of a call. */
  ping?: boolean;
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

/** Writes one finished row of the log through its repository, as the launcher writes it, and returns its id. */
export async function seedCall(log: AgentCallRepository, call: SeededCall): Promise<number> {
  const chatId = call.chatId ?? `chat-${(nextChat += 1)}`;
  const common = { startedAt: AT, runtime: 'claude', model: 'claude-opus-5-5', requestText: 'ask' };
  const id = call.ping
    ? await pingRow(log, call, chatId, common)
    : await log.open({
        ...common,
        kind: 'call',
        resumed: false,
        runKey: call.runKey,
        step: call.step ?? 'implement',
        chatId,
        ...(call.attemptId ? { attemptId: call.attemptId } : {}),
      });
  await log.addRequest(id, {
    model: common.model,
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

async function pingRow(
  log: AgentCallRepository,
  call: SeededCall,
  chatId: string,
  common: { startedAt: string; runtime: string; model: string; requestText: string },
): Promise<number> {
  const id = await log.insertPing({
    ...common,
    dueAt: `due-${chatId}`,
    chatId,
    previousId: 0,
    runKey: call.runKey,
    ...(call.step ? { step: call.step } : {}),
  });
  if (id === null) {
    throw new Error(`the ping of ${chatId} is already seeded`);
  }
  return id;
}
