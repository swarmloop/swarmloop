import { Column, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

@Entity('runs')
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
}

@Entity('documents')
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
}

@Entity('resource_samples')
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
}

@Entity('agent_exchanges')
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
  CommandEntity,
];
