import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** A backlog: the project. Its repositories are a JSON array of names. */
@Entity('backlogs')
@Index('IDX_backlogs_name', ['name'], { unique: true })
export class BacklogEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ type: 'text' })
  name!: string;

  @Column({ type: 'text' })
  owner!: string;

  @Column({ type: 'text' })
  repositories!: string;

  @Column({ name: 'merge_mode', type: 'text' })
  mergeMode!: string;

  @Column({ type: 'boolean', default: false })
  paused!: boolean;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;
}

@Entity('backlog_milestones')
@Index('IDX_backlog_milestones_backlog_number', ['backlogId', 'number'], { unique: true })
export class MilestoneEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'backlog_id', type: 'integer' })
  backlogId!: number;

  @Column({ type: 'integer' })
  number!: number;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text' })
  goal!: string;

  @Column({ type: 'text' })
  status!: string;

  @Column({ name: 'queued_after_id', type: 'integer', nullable: true })
  queuedAfterId!: number | null;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;
}

@Entity('backlog_requirements')
@Index('IDX_backlog_requirements_milestone_ref', ['milestoneId', 'ref'], { unique: true })
export class RequirementEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'milestone_id', type: 'integer' })
  milestoneId!: number;

  /** The id `M<number>.R<n>`. */
  @Column({ type: 'text' })
  ref!: string;

  @Column({ type: 'text' })
  text!: string;

  @Column({ type: 'text' })
  status!: string;
}

/** A task of a backlog. Repositories, covers, depends, files and proof are JSON arrays, merged a JSON map of commits. */
@Entity('backlog_tasks')
@Index('IDX_backlog_tasks_backlog_slug', ['backlogId', 'slug'], { unique: true })
@Index('IDX_backlog_tasks_run_key', ['runKey'])
export class BacklogTaskEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'backlog_id', type: 'integer' })
  backlogId!: number;

  @Column({ name: 'milestone_id', type: 'integer', nullable: true })
  milestoneId!: number | null;

  @Column({ type: 'text' })
  slug!: string;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'text' })
  repositories!: string;

  @Column({ type: 'text' })
  covers!: string;

  @Column({ type: 'text' })
  depends!: string;

  @Column({ type: 'text' })
  files!: string;

  @Column({ type: 'text' })
  proof!: string;

  @Column({ type: 'boolean', default: false })
  manual!: boolean;

  @Column({ name: 'fixes_main', type: 'text', nullable: true })
  fixesMain!: string | null;

  @Column({ type: 'text' })
  status!: string;

  @Column({ name: 'run_key', type: 'text', nullable: true })
  runKey!: string | null;

  @Column({ type: 'text', default: '' })
  note!: string;

  @Column({ name: 'run_now', type: 'boolean', default: false })
  runNow!: boolean;

  @Column({ name: 'merge_ok', type: 'boolean', default: false })
  mergeOk!: boolean;

  @Column({ type: 'text' })
  merged!: string;

  @Column({ name: 'made_by', type: 'text' })
  madeBy!: string;

  @Column({ type: 'integer' })
  position!: number;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;
}

@Entity('backlog_decisions')
export class DecisionEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'backlog_id', type: 'integer' })
  backlogId!: number;

  @Column({ type: 'text' })
  text!: string;

  @Column({ type: 'text' })
  who!: string;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;
}

/** An event of a backlog, written once per key. Facts are a JSON map. The turn is empty until a planner handles it. */
@Entity('backlog_events')
@Index('IDX_backlog_events_backlog_key', ['backlogId', 'eventKey'], { unique: true })
@Index('IDX_backlog_events_backlog_turn', ['backlogId', 'turn'])
export class BacklogEventEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'backlog_id', type: 'integer' })
  backlogId!: number;

  @Column({ name: 'event_key', type: 'text' })
  eventKey!: string;

  @Column({ type: 'text' })
  kind!: string;

  @Column({ type: 'text' })
  facts!: string;

  @Column({ type: 'text', nullable: true })
  turn!: string | null;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;
}
