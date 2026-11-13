import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

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

  /** JSON map of project to the content tree a checks visit ran on. Null for any other visit. */
  @Column({ name: 'checked_commits', type: 'text', nullable: true })
  checkedCommits!: string | null;

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

  /** Bash tool calls of the visit that changed files through a script or `sed -i`. */
  @Column({ name: 'shell_edits', type: 'integer', default: 0 })
  shellEdits!: number;
}
