import { ConnectionEntity, HostAppEntity, IntegrationSecretEntity, UserSettingEntity } from './connection-entities';
import { CredentialCooldownEntity } from './credential-cooldown.entity';
import { RunEntity } from './run.entity';
import { FlakyTestEntity } from './flaky-test.entity';
import { RuntimeCooldownEntity } from './runtime-cooldown.entity';
import { SessionEntity } from './session.entity';
import { StepStatEntity } from './step-stat.entity';
import { Column, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';

export { StepStatEntity } from './step-stat.entity';
export { RunEntity } from './run.entity';

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

  /** JSON about the return: the failed commands of a checks return, the failed jobs of a pipeline return. Null on older rows. */
  @Column({ type: 'text', nullable: true })
  detail!: string | null;

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
@Index('IDX_check_commands_attempt_id', ['attemptId'])
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

  /** The short name the checks list shows; null on rows from before names. */
  @Column({ type: 'varchar', nullable: true })
  name!: string | null;

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
  FlakyTestEntity,
  SessionEntity,
  HostAppEntity,
  ConnectionEntity,
  UserSettingEntity,
  IntegrationSecretEntity,
  CredentialCooldownEntity,
];
