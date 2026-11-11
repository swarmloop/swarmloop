import { ConnectionEntity, HostAppEntity } from './connection-entities';
import { Column, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

@Entity('runs')
@Index('IDX_runs_parent_run_id', ['parentRunId'])
export class RunEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  key!: string;

  @Column()
  status!: string;

  @Column({ name: 'current_step' })
  currentStep!: string;

  @Column()
  runtime!: string;

  @Column({ name: 'requirements_via' })
  requirementsVia!: string;

  @Column({ name: 'issue_tracker' })
  issueTracker!: string;

  @Column({ name: 'code_host' })
  codeHost!: string;

  @Column({ name: 'attempts_review', type: 'integer', default: 0 })
  attemptsReview!: number;

  @Column({ name: 'attempts_qa', type: 'integer', default: 0 })
  attemptsQa!: number;

  @Column({ name: 'attempts_pipeline', type: 'integer', default: 0 })
  attemptsPipeline!: number;

  @Column({ name: 'attempts_checks', type: 'integer', default: 0 })
  attemptsChecks!: number;

  @Column({ name: 'agent_calls', type: 'integer', default: 0 })
  agentCalls!: number;

  @Column({ name: 'spent_usd', type: 'float', default: 0 })
  spentUsd!: number;

  @Column({ name: 'target_path', type: 'text', nullable: true })
  targetPath!: string | null;

  @Column({ type: 'text', nullable: true })
  projects!: string | null;

  @Column({ name: 'owner_pid', type: 'integer', nullable: true })
  ownerPid!: number | null;

  @Column({ type: 'integer', default: 0 })
  revision!: number;

  /** Grows by one when a Replay or a Rebase is accepted. A gate counts only for the generation it was written in. */
  @Column({ type: 'integer', default: 0 })
  generation!: number;

  /** 'removed' after retention took the worktrees of a done run; the next action recreates them. */
  @Column({ type: 'text', nullable: true })
  workspace!: string | null;

  @Column({ name: 'active_attempt', type: 'text', nullable: true })
  activeAttempt!: string | null;

  @Column({ name: 'owner_instance', type: 'text', nullable: true })
  ownerInstance!: string | null;

  /** The honest state of the run. Null on a row written before it existed; `deriveState` reads those. */
  @Column({ type: 'text', nullable: true })
  state!: string | null;

  /** JSON `{ code, message }` for the state. */
  @Column({ name: 'state_reason', type: 'text', nullable: true })
  stateReason!: string | null;

  @Column({ type: 'text', nullable: true })
  prompt!: string | null;

  @Column({ name: 'created_at' })
  createdAt!: string;

  @Column({ name: 'updated_at' })
  updatedAt!: string;

  @Column({ name: 'step_started_at', type: 'text', nullable: true })
  stepStartedAt!: string | null;

  /** The run this one is a subtask of. Null for a run that is not a subtask. */
  @Column({ name: 'parent_run_id', type: 'integer', nullable: true })
  parentRunId!: number | null;

  /** The task id inside the parent's `subtasks` document. */
  @Column({ name: 'task_id', type: 'text', nullable: true })
  taskId!: string | null;

  /** The planner may split this run into subtasks. Always false for a subtask. */
  @Column({ type: 'boolean', default: false })
  split!: boolean;

  /** Who started the run: a login name, or `machine` for the token. Null for a run the CLI started and for old rows. */
  @Column({ name: 'started_by', type: 'text', nullable: true })
  startedBy!: string | null;
}

@Entity('documents')
@Index('IDX_documents_step_stat_id', ['stepStatId'])
@Index('IDX_documents_run_id', ['runId'])
export class DocumentEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'run_id', type: 'integer' })
  runId!: number;

  @Column({ name: 'step_stat_id', type: 'integer' })
  stepStatId!: number;

  @Column()
  kind!: string;

  @Column({ type: 'integer' })
  attempt!: number;

  @Column({ type: 'text' })
  body!: string;

  @Column()
  path!: string;

  /** JSON `{ generation, fingerprint }` of a gate: what the document was written for. Null when it is no gate. */
  @Column({ type: 'text', nullable: true })
  stamp!: string | null;

  @Column({ name: 'created_at' })
  createdAt!: string;
}

@Entity('step_stats')
@Index('IDX_step_stats_run_id', ['runId'])
@Index('IDX_step_stats_attempt_id', ['attemptId'], { unique: true, where: '"attempt_id" IS NOT NULL' })
export class StepStatEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'run_id', type: 'integer' })
  runId!: number;

  @Column()
  step!: string;

  @Column({ type: 'integer' })
  attempt!: number;

  @Column({ type: 'text', nullable: true })
  runtime!: string | null;

  @Column({ type: 'text', nullable: true })
  model!: string | null;

  @Column({ type: 'text', nullable: true })
  mode!: string | null;

  @Column({ name: 'started_at' })
  startedAt!: string;

  @Column({ name: 'step_started_at', type: 'text', nullable: true })
  stepStartedAt!: string | null;

  @Column({ name: 'attempt_id', type: 'text', nullable: true })
  attemptId!: string | null;

  @Column({ name: 'finished_at' })
  finishedAt!: string;

  @Column({ name: 'duration_ms', type: 'integer' })
  durationMs!: number;

  @Column()
  status!: string;

  @Column({ name: 'exit_code', type: 'integer', nullable: true })
  exitCode!: number | null;

  @Column({ name: 'kill_reason', type: 'text', nullable: true })
  killReason!: string | null;

  @Column({ name: 'tokens_in', type: 'integer', default: 0 })
  tokensIn!: number;

  @Column({ name: 'tokens_out', type: 'integer', default: 0 })
  tokensOut!: number;

  @Column({ type: 'float', default: 0 })
  usd!: number;

  @Column({ name: 'cpu_avg', type: 'float', default: 0 })
  cpuAvg!: number;

  @Column({ name: 'cpu_peak', type: 'float', default: 0 })
  cpuPeak!: number;

  @Column({ name: 'mem_avg', type: 'integer', default: 0 })
  memAvg!: number;

  @Column({ name: 'mem_peak', type: 'integer', default: 0 })
  memPeak!: number;

  @Column({ type: 'integer', default: 0 })
  resumed!: number;

  /** What the run waited for between the end of the visit before and this visit's first event. Null for the first visit. */
  @Column({ name: 'prepared_ms', type: 'integer', nullable: true })
  preparedMs!: number | null;
}

@Entity('resource_samples')
@Index('IDX_resource_samples_step_stat_id', ['stepStatId'])
export class ResourceSampleEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'step_stat_id', type: 'integer' })
  stepStatId!: number;

  @Column({ name: 'sampled_at' })
  sampledAt!: string;

  @Column({ name: 'cpu_percent', type: 'float' })
  cpuPercent!: number;

  @Column({ name: 'rss_bytes', type: 'integer' })
  rssBytes!: number;

  /** `agent`, `setup`, or the index of a check command. Null on a row from before sources: it was an agent. */
  @Column({ type: 'varchar', nullable: true })
  source!: string | null;
}

@Entity('agent_exchanges')
@Index('IDX_agent_exchanges_step_stat_id', ['stepStatId'])
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
}

@Entity('loop_events')
@Index('IDX_loop_events_run_id', ['runId'])
export class LoopEventEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'run_id', type: 'integer' })
  runId!: number;

  @Column()
  counter!: string;

  @Column({ type: 'integer' })
  attempt!: number;

  @Column({ type: 'text' })
  reason!: string;

  @Column({ name: 'created_at' })
  createdAt!: string;
}

@Entity('checkouts')
export class CheckoutEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  name!: string;

  @Column({ type: 'text' })
  path!: string;
}

@Entity('deny_paths')
export class DenyPathEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ unique: true })
  pattern!: string;
}

@Entity('pastes')
@Index('IDX_pastes_run_key', ['runKey'])
export class PasteEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'run_key' })
  runKey!: string;

  @Column()
  url!: string;

  @Column({ type: 'text' })
  body!: string;
}

@Entity('http_calls')
@Index('IDX_http_calls_run_id', ['runId'])
export class HttpCallEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'run_id', type: 'integer' })
  runId!: number;

  @Column({ name: 'step_stat_id', type: 'integer' })
  stepStatId!: number;

  @Column()
  provider!: string;

  @Column()
  method!: string;

  @Column()
  url!: string;

  @Column({ name: 'status_code', type: 'integer', nullable: true })
  statusCode!: number | null;

  @Column({ name: 'duration_ms', type: 'integer' })
  durationMs!: number;

  @Column({ type: 'text', nullable: true })
  error!: string | null;

  @Column({ name: 'created_at' })
  createdAt!: string;
}

@Entity('flows')
@Index('IDX_flows_run_id', ['runId'])
export class FlowEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'run_id', type: 'integer' })
  runId!: number;

  @Column({ type: 'text' })
  phases!: string;

  @Column({ name: 'from_step', type: 'text', nullable: true })
  fromStep!: string | null;

  @Column({ name: 'created_at' })
  createdAt!: string;
}

@Entity('step_events')
@Index('IDX_step_events_run_seq', ['runId', 'seq'], { unique: true })
export class StepEventEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'run_id', type: 'integer' })
  runId!: number;

  @Column({ name: 'attempt_id' })
  attemptId!: string;

  @Column()
  step!: string;

  @Column({ type: 'integer' })
  seq!: number;

  @Column()
  kind!: string;

  @Column({ type: 'text' })
  payload!: string;

  @Column({ name: 'occurred_at' })
  occurredAt!: string;

  @Column({ name: 'recorded_at' })
  recordedAt!: string;
}

/** One command of a checks visit. The row exists from the start of the visit, so the window can show it waiting. */
@Entity('check_commands')
@Index('IDX_check_commands_run_id', ['runId'])
export class CheckCommandEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'run_id', type: 'integer' })
  runId!: number;

  /** The attempt of the checks visit, as on `step_stats`. */
  @Column({ name: 'attempt_id' })
  attemptId!: string;

  @Column()
  repo!: string;

  @Column({ type: 'text' })
  command!: string;

  @Column({ name: 'command_index', type: 'integer' })
  commandIndex!: number;

  @Column()
  status!: string;

  @Column({ type: 'integer', default: 0 })
  skipped!: number;

  @Column({ name: 'started_at', type: 'varchar', nullable: true })
  startedAt!: string | null;

  @Column({ name: 'ended_at', type: 'varchar', nullable: true })
  endedAt!: string | null;

  @Column({ name: 'exit_code', type: 'integer', nullable: true })
  exitCode!: number | null;
}

@Entity('commands')
@Index('IDX_commands_run_idempotency', ['runId', 'idempotencyKey'], { unique: true })
export class CommandEntity {
  @PrimaryColumn()
  id!: string;

  @Column({ name: 'run_id', type: 'integer' })
  runId!: number;

  @Column()
  type!: string;

  @Column({ type: 'text' })
  payload!: string;

  @Column({ name: 'idempotency_key', type: 'text', nullable: true })
  idempotencyKey!: string | null;

  @Column({ name: 'expected_revision', type: 'integer', nullable: true })
  expectedRevision!: number | null;

  @Column()
  state!: string;

  @Column({ type: 'text', nullable: true })
  result!: string | null;

  @Column({ name: 'created_at' })
  createdAt!: string;

  @Column({ name: 'updated_at' })
  updatedAt!: string;
}

/** One runtime whose provider limit has not ended. All runs share it, because they share the subscription. */
@Entity('runtime_cooldowns')
export class RuntimeCooldownEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text', unique: true })
  runtime!: string;

  /** When the runtime may be used again, ISO 8601 UTC. */
  @Column({ type: 'text' })
  until!: string;

  /** 1 when `until` is the reset the provider named, 0 when it is the default cooldown. */
  @Column({ name: 'reset_known', type: 'integer' })
  resetKnown!: number;
}

/** A login session. The cookie holds `id`; the row says who it is and when it ends. */
@Entity('sessions')
export class SessionEntity {
  @PrimaryColumn({ type: 'text' })
  id!: string;

  @Column({ type: 'text' })
  user!: string;

  @Column({ type: 'text' })
  provider!: string;

  /** ISO 8601 UTC. */
  @Column({ name: 'expires_at', type: 'text' })
  expiresAt!: string;
}

export const entities = [
  RunEntity,
  DocumentEntity,
  StepStatEntity,
  ResourceSampleEntity,
  AgentExchangeEntity,
  LoopEventEntity,
  HttpCallEntity,
  PasteEntity,
  CheckoutEntity,
  DenyPathEntity,
  FlowEntity,
  StepEventEntity,
  CheckCommandEntity,
  CommandEntity,
  RuntimeCooldownEntity,
  SessionEntity,
  HostAppEntity,
  ConnectionEntity,
];
