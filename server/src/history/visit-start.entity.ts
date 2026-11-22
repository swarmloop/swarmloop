import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * How an agent start was made, written when it starts. A row is a hop's visit of a step, or an outside start (a
 * planner turn, a reviewer) that is no step's visit. The visit's `step_stats` row is joined by `attemptId`, and by
 * `statId` once an outside start stored its visit; a start with no such row did not finish.
 */
@Entity('visit_starts')
@Index('IDX_visit_starts_attempt_id', ['attemptId'], { unique: true })
@Index('IDX_visit_starts_run_id', ['runId'])
export class VisitStartEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'run_id', type: 'integer' })
  runId!: number;

  @Column({ type: 'text' })
  step!: string;

  @Column({ name: 'attempt_id', type: 'text' })
  attemptId!: string;

  /** `person`, `planner` or `machine`. */
  @Column({ name: 'started_by', type: 'text' })
  startedBy!: string;

  /** The planner level that asked; null unless a planner started the visit. */
  @Column({ type: 'integer', nullable: true })
  level!: number | null;

  /** The digest of the input the visit started on; null when unknown. */
  @Column({ name: 'input_digest', type: 'text', nullable: true })
  inputDigest!: string | null;

  /** The code of the run's stored reason when the start was made; null for none. */
  @Column({ name: 'start_reason', type: 'text', nullable: true })
  startReason!: string | null;

  /** True when the start runs again a visit of the step that did not finish. */
  @Column({
    name: 'rerun_unfinished',
    type: 'integer',
    default: 0,
    transformer: { to: (v: boolean) => (v ? 1 : 0), from: (v: number) => v === 1 },
  })
  rerunUnfinished!: boolean;

  /** True when the start is not a step's visit: a planner turn, a reviewer, a chat. */
  @Column({
    type: 'integer',
    default: 0,
    transformer: { to: (v: boolean) => (v ? 1 : 0), from: (v: number) => v === 1 },
  })
  outside!: boolean;

  /** The stored visit (`step_stats` id) this start led to; null until it is stored. */
  @Column({ name: 'stat_id', type: 'integer', nullable: true })
  statId!: number | null;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;
}
