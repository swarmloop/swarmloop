import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

@Entity('agent_exchanges')
@Index('IDX_agent_exchanges_step_stat_id', ['stepStatId'])
@Index('IDX_agent_exchanges_chat_id', ['chatId'])
@Index('IDX_agent_exchanges_run_key', ['runKey'])
@Index('IDX_agent_exchanges_turn_key', ['turnKey'])
@Index('IDX_agent_exchanges_attempt_id', ['attemptId'])
@Index('IDX_agent_exchanges_ping_due', ['chatId', 'dueAt'], { unique: true, where: "kind = 'ping'" })
export class AgentExchangeEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'step_stat_id', type: 'integer' })
  stepStatId!: number;

  @Column()
  model!: string;

  @Column({ name: 'started_at' })
  startedAt!: string;

  @Column({ name: 'finished_at' })
  finishedAt!: string;

  @Column({ name: 'duration_ms', type: 'integer' })
  durationMs!: number;

  @Column({ name: 'request_text', type: 'text' })
  requestText!: string;

  @Column({ name: 'response_text', type: 'text' })
  responseText!: string;

  @Column({ name: 'chat_id', type: 'text', nullable: true })
  chatId!: string | null;

  @Column({ type: 'integer', default: 0 })
  resumed!: number;

  @Column({ name: 'kill_reason', type: 'text', nullable: true })
  killReason!: string | null;

  /** The session totals the launch's last result line reported. The next launch of the chat is taken against them. Null when it reported none. */
  @Column({ name: 'reported_usd', type: 'float', nullable: true })
  reportedUsd!: number | null;

  @Column({ name: 'reported_tokens_in', type: 'integer', nullable: true })
  reportedTokensIn!: number | null;

  @Column({ name: 'reported_tokens_out', type: 'integer', nullable: true })
  reportedTokensOut!: number | null;

  // The log's columns: one row per agent call, its helpers, failovers and pings. Own sums are this row's, never a sum over rows.
  /** `call`, `helper`, `ping` or `ping-stop`. */
  @Column({ type: 'text', default: 'call' })
  kind!: string;

  @Column({ name: 'parent_id', type: 'integer', nullable: true })
  parentId!: number | null;

  @Column({ name: 'previous_id', type: 'integer', nullable: true })
  previousId!: number | null;

  @Column({ name: 'replaces_id', type: 'integer', nullable: true })
  replacesId!: number | null;

  @Column({ name: 'run_key', type: 'text', nullable: true })
  runKey!: string | null;

  @Column({ name: 'turn_key', type: 'text', nullable: true })
  turnKey!: string | null;

  @Column({ type: 'text', nullable: true })
  backlog!: string | null;

  @Column({ name: 'task_slug', type: 'text', nullable: true })
  taskSlug!: string | null;

  @Column({ name: 'epic_key', type: 'text', nullable: true })
  epicKey!: string | null;

  @Column({ type: 'text', nullable: true })
  step!: string | null;

  @Column({ name: 'planner_level', type: 'text', nullable: true })
  plannerLevel!: string | null;

  @Column({ type: 'text', nullable: true })
  purpose!: string | null;

  @Column({ name: 'start_reason', type: 'text', nullable: true })
  startReason!: string | null;

  @Column({ name: 'attempt_id', type: 'text', nullable: true })
  attemptId!: string | null;

  @Column({ name: 'chat_idle_min', type: 'float', nullable: true })
  chatIdleMin!: number | null;

  @Column({ type: 'text', nullable: true })
  runtime!: string | null;

  @Column({ type: 'text', nullable: true })
  effort!: string | null;

  @Column({ type: 'text', nullable: true })
  usage!: string | null;

  @Column({ type: 'text', nullable: true })
  prices!: string | null;

  @Column({ type: 'text', nullable: true })
  ties!: string | null;

  @Column({ name: 'input_tokens', type: 'integer', default: 0 })
  inputTokens!: number;

  @Column({ name: 'cache_read_tokens', type: 'integer', default: 0 })
  cacheReadTokens!: number;

  @Column({ name: 'cache_write_tokens', type: 'integer', default: 0 })
  cacheWriteTokens!: number;

  @Column({ name: 'output_tokens', type: 'integer', default: 0 })
  outputTokens!: number;

  @Column({ name: 'own_usd', type: 'float', default: 0 })
  ownUsd!: number;

  @Column({ name: 'end_kind', type: 'text', nullable: true })
  endKind!: string | null;

  @Column({ name: 'error_class', type: 'text', nullable: true })
  errorClass!: string | null;

  @Column({ name: 'error_text', type: 'text', nullable: true })
  errorText!: string | null;

  @Column({ name: 'exit_code', type: 'integer', nullable: true })
  exitCode!: number | null;

  @Column({ name: 'limit_window', type: 'text', nullable: true })
  limitWindow!: string | null;

  @Column({ name: 'limit_resets_at', type: 'text', nullable: true })
  limitResetsAt!: string | null;

  @Column({ name: 'refused_reason', type: 'text', nullable: true })
  refusedReason!: string | null;

  @Column({ name: 'stop_reason', type: 'text', nullable: true })
  stopReason!: string | null;

  @Column({ name: 'due_at', type: 'text', nullable: true })
  dueAt!: string | null;
}
