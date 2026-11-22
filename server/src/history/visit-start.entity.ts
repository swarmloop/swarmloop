import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** How an agent visit was started, written when it starts. The visit's `step_stats` row is joined by `attemptId`; a start with no such row is a visit that did not finish. */
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

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;
}
