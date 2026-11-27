import type { DataSource } from 'typeorm';

/** The start of a row that keep-warm pings once wrote. The product no longer writes them; a spec seeds the history it must still read. */
export interface PastPing {
  startedAt: string;
  chatId: string;
  previousId: number;
  runKey: string;
  /** Makes the row the mark where a chat's pings stopped, ended as done, instead of a ping. */
  stopReason?: string;
  /** The due time of a ping, which is unique for its chat; its start when left out. */
  dueAt?: string;
  step?: string;
  taskSlug?: string;
}

/** Inserts the start columns of one past ping or ping-stop row and returns its id. Tokens and cost go through the repository's addRequest and finish. */
export async function seedPastPing(data: DataSource, row: PastPing): Promise<number> {
  const stop = row.stopReason !== undefined;
  const [inserted] = await data.query<{ id: number }[]>(
    `INSERT INTO agent_exchanges (
       kind, step_stat_id, started_at, finished_at, duration_ms, response_text, end_kind, stop_reason, previous_id,
       run_key, step, task_slug, start_reason, chat_id, resumed, runtime, model, request_text, due_at
     ) VALUES (?, 0, ?, ?, 0, '', ?, ?, ?, ?, ?, ?, ?, ?, 1, 'claude', 'claude-opus-5-5', ?, ?) RETURNING id`,
    [
      stop ? 'ping-stop' : 'ping',
      row.startedAt,
      stop ? row.startedAt : '',
      stop ? 'done' : 'running',
      row.stopReason ?? null,
      row.previousId,
      row.runKey,
      row.step ?? null,
      row.taskSlug ?? null,
      stop ? null : 'ping',
      row.chatId,
      stop ? '' : 'ping',
      stop ? null : (row.dueAt ?? row.startedAt),
    ],
  );
  return inserted.id;
}
