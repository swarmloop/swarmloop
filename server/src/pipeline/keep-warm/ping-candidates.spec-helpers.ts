import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { AgentCallRepository } from '../../history/agent-call.repository';
import { AgentExchangeEntity } from '../../history/entities';
import type { RunEntity } from '../../history/entities';
import { repositoryDatabase } from '../../history/repository.spec-helpers';
import { RunRepository } from '../../history/run.repository';
import { writeRunState } from '../../history/run-state';
import type { RunStateChange } from '../../history/run-state';
import { sessionFileName, sessionHome } from '../../history/session-group';
import { agentStateDir } from '../../sandbox/sandbox-launch';

const MINUTE_MS = 60_000;

/** What a seeded chat of a run is like: where its session is kept and what its last row says. */
interface ChatSeed {
  /** The session home of the chat: plan, implement or a reviewer's step. Defaults to implement. */
  home?: string;
  chatId?: string;
  /** Minutes since the chat's last row ended. */
  idleMin?: number;
  runtime?: string;
  model?: string;
  /** The last row is open, not ended. */
  open?: boolean;
  /** Writes no session file: the chat is an old one a fresh chat replaced. */
  replaced?: boolean;
}

/** The pieces a spec of keep-warm needs: a database, the log, runs with their session files, and a clock to move. */
export async function keepWarmDatabase() {
  const db = await repositoryDatabase();
  const runs = db.app.get(RunRepository);
  const calls = db.app.get(AgentCallRepository);
  mkdirSync(join(db.root, 'data'), { recursive: true });
  let chats = 0;

  const ago = (minutes: number): string => new Date(db.clock.now() - minutes * MINUTE_MS).toISOString();

  /** A run in the given state, with an optional change of its row. */
  const run = async (
    key: string,
    state: RunStateChange = { status: 'waiting' },
    columns: Partial<RunEntity> = {},
  ): Promise<RunEntity> => {
    await runs.begin(key, 'implement');
    return runs.change(key, (row) => {
      writeRunState(row, { currentStep: 'implement', ...state });
      Object.assign(row, columns);
    });
  };

  /** A chat of the run: its session file and the state folder that holds it, and one finished call as its last row. */
  const chat = async (key: string, seed: ChatSeed = {}): Promise<{ chatId: string; callId: number }> => {
    const home = seed.home ?? 'implement';
    const chatId = seed.chatId ?? `chat-${(chats += 1)}`;
    if (!seed.replaced) {
      mkdirSync(agentStateDir(db.root, key, sessionHome(home)), { recursive: true });
      writeFileSync(
        join(db.root, 'data', sessionFileName(key, home)),
        JSON.stringify({ chatId, resumed: true, completed: true, killReason: null, runtime: seed.runtime ?? 'claude' }),
      );
    }
    const startedAt = ago(seed.idleMin ?? 0);
    const callId = await calls.open({
      kind: 'call',
      startedAt,
      resumed: false,
      runtime: seed.runtime ?? 'claude',
      model: seed.model ?? 'claude-opus-5-5',
      effort: 'high',
      requestText: 'go',
      runKey: key,
      step: home,
      chatId,
    });
    if (!seed.open) {
      await calls.finish(callId, { endKind: 'done', finishedAt: startedAt, durationMs: 1, responseText: 'ok' });
    }
    return { chatId, callId };
  };

  /** The nth ping of the chat after its last call, ended `idleMin` minutes ago. */
  const ping = async (
    key: string,
    chatId: string,
    previousId: number,
    nth: number,
    ended: { idleMin?: number; endKind?: 'done' | 'failed' } = {},
  ): Promise<number> => {
    const at = ago(ended.idleMin ?? 0);
    const id = await calls.insertPing({
      startedAt: at,
      dueAt: new Date(Date.UTC(2025, 0, 1) + nth * MINUTE_MS).toISOString(),
      chatId,
      previousId,
      runKey: key,
      step: 'implement',
      runtime: 'claude',
      model: 'claude-opus-5-5',
      effort: 'high',
      requestText: 'one word',
    });
    await calls.finish(id as number, {
      endKind: ended.endKind ?? 'done',
      finishedAt: at,
      durationMs: 1,
      responseText: 'ok',
    });
    return id as number;
  };

  /** The chat and the reason of each ping-stop row of the log, in order. */
  const stops = async (): Promise<[string | null, string | null][]> =>
    (
      await db.app
        .get(DataSource)
        .getRepository(AgentExchangeEntity)
        .find({ where: { kind: 'ping-stop' }, order: { id: 'ASC' } })
    ).map((row) => [row.chatId, row.stopReason]);

  return { ...db, runs, calls, run, chat, ping, ago, stops };
}
