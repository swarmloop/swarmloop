import type { QueryRunner } from 'typeorm';

/** How a stored visit ended, as the log says it. */
const VISIT_END = `CASE
  WHEN s.status = 'done' THEN 'done'
  WHEN s.kill_reason = 'RUNTIME_LIMIT' THEN 'limit'
  WHEN s.kill_reason = 'DOCKER_UNAVAILABLE' THEN 'outage'
  WHEN s.kill_reason = 'timeout' THEN 'timed-out'
  WHEN s.kill_reason = 'stop' THEN 'stopped'
  ELSE 'failed'
END`;

const TURN_END = `CASE
  WHEN t.status IN ('done', 'applied') THEN 'done'
  WHEN t.status = 'running' THEN 'running'
  WHEN t.status = 'waiting' AND t.reason = 'RUNTIME_LIMIT' THEN 'limit'
  WHEN t.status = 'waiting' THEN 'outage'
  ELSE 'failed'
END`;

/** The backlog's name, the task's slug and the epic's key of a run, by its key and its parent chain. */
const RUN_TIES = `
  (SELECT b.name FROM backlog_tasks k JOIN backlogs b ON b.id = k.backlog_id WHERE k.run_key = r.key LIMIT 1) AS backlog,
  (SELECT k.slug FROM backlog_tasks k WHERE k.run_key = r.key LIMIT 1) AS task_slug,
  CASE
    WHEN r.parent_run_id IS NOT NULL THEN (SELECT p.key FROM runs p WHERE p.id = r.parent_run_id)
    WHEN EXISTS (SELECT 1 FROM runs c WHERE c.parent_run_id = r.id) THEN r.key
    ELSE NULL
  END AS epic_key`;

/**
 * Gives the rows `agent_exchanges` already holds the log's columns, and puts the old cost sources onto its rows,
 * so that the sums over the log equal the sums of `step_stats` and `backlog_turns`. Raw SQL only: a migration shares no app code.
 * It never touches the `reported_*` columns.
 */
export async function backfillAgentCallLog(queryRunner: QueryRunner): Promise<void> {
  // (a) and (b): the identity of every old row, from its visit and its run.
  await queryRunner.query(`
    UPDATE agent_exchanges SET
      run_key = (SELECT r.key FROM step_stats s JOIN runs r ON r.id = s.run_id WHERE s.id = agent_exchanges.step_stat_id),
      step = (SELECT s.step FROM step_stats s WHERE s.id = agent_exchanges.step_stat_id),
      attempt_id = (SELECT s.attempt_id FROM step_stats s WHERE s.id = agent_exchanges.step_stat_id),
      runtime = (SELECT s.runtime FROM step_stats s WHERE s.id = agent_exchanges.step_stat_id),
      effort = (SELECT s.effort FROM step_stats s WHERE s.id = agent_exchanges.step_stat_id),
      end_kind = (SELECT ${VISIT_END} FROM step_stats s WHERE s.id = agent_exchanges.step_stat_id)
    WHERE step_stat_id > 0`);
  await queryRunner.query(`
    UPDATE agent_exchanges SET
      backlog = (SELECT x.backlog FROM (SELECT r.key AS key, ${RUN_TIES} FROM runs r) x WHERE x.key = agent_exchanges.run_key),
      task_slug = (SELECT x.task_slug FROM (SELECT r.key AS key, ${RUN_TIES} FROM runs r) x WHERE x.key = agent_exchanges.run_key),
      epic_key = (SELECT x.epic_key FROM (SELECT r.key AS key, ${RUN_TIES} FROM runs r) x WHERE x.key = agent_exchanges.run_key)
    WHERE run_key IS NOT NULL`);

  // (c): a visit's own cost and tokens go onto its last exchange row; its other rows keep 0.
  await queryRunner.query(`
    UPDATE agent_exchanges SET
      own_usd = (SELECT s.usd FROM step_stats s WHERE s.id = agent_exchanges.step_stat_id),
      input_tokens = (SELECT s.tokens_in FROM step_stats s WHERE s.id = agent_exchanges.step_stat_id),
      output_tokens = (SELECT s.tokens_out FROM step_stats s WHERE s.id = agent_exchanges.step_stat_id)
    WHERE id IN (SELECT MAX(id) FROM agent_exchanges WHERE step_stat_id > 0 GROUP BY step_stat_id)`);

  // (d): a visit that cost something and has no exchange gets one row.
  await queryRunner.query(`
    INSERT INTO agent_exchanges (
      kind, step_stat_id, model, started_at, finished_at, duration_ms, request_text, response_text,
      run_key, step, attempt_id, runtime, effort, end_kind, own_usd, input_tokens, output_tokens,
      backlog, task_slug, epic_key
    )
    SELECT 'call', s.id, COALESCE(s.model, ''), s.started_at, s.finished_at, s.duration_ms, '', '',
      r.key, s.step, s.attempt_id, s.runtime, s.effort, ${VISIT_END}, s.usd, s.tokens_in, s.tokens_out,
      x.backlog, x.task_slug, x.epic_key
    FROM step_stats s
    JOIN runs r ON r.id = s.run_id
    JOIN (SELECT r.key AS key, ${RUN_TIES} FROM runs r) x ON x.key = r.key
    WHERE (s.usd > 0 OR s.tokens_in > 0 OR s.tokens_out > 0)
      AND NOT EXISTS (SELECT 1 FROM agent_exchanges e WHERE e.step_stat_id = s.id)`);

  // (e): a planner turn becomes one row under its turn key.
  await queryRunner.query(`
    INSERT INTO agent_exchanges (
      kind, step_stat_id, model, started_at, finished_at, duration_ms, request_text, response_text,
      turn_key, step, planner_level, purpose, backlog, runtime, effort, end_kind, own_usd, input_tokens, output_tokens
    )
    SELECT 'call', 0, COALESCE(t.model, ''), t.created_at, t.created_at, t.duration_ms, '', '',
      t.turn_key, 'backlog-plan', 'backlog', 'backlog-turn', b.name, t.runtime, t.effort, ${TURN_END},
      t.usd, t.tokens_in, t.tokens_out
    FROM backlog_turns t
    LEFT JOIN backlogs b ON b.id = t.backlog_id
    WHERE NOT EXISTS (SELECT 1 FROM agent_exchanges e WHERE e.turn_key = t.turn_key)`);
}
