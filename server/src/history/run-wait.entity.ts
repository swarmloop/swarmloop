import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** One stretch in which a run did not work on its own: it waited for a person or for a next try. Open while `endedAt` is null. */
@Entity('run_waits')
@Index('IDX_run_waits_run_id', ['runId'])
export class RunWaitEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'run_id', type: 'integer' })
  runId!: number;

  /** `person` or `timed`. */
  @Column({ type: 'text' })
  kind!: string;

  /** The code of the reason the run waited for. */
  @Column({ type: 'text', nullable: true })
  code!: string | null;

  @Column({ name: 'started_at', type: 'text' })
  startedAt!: string;

  @Column({ name: 'ended_at', type: 'text', nullable: true })
  endedAt!: string | null;
}
