import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/** One time a test failed and then passed on the same code. A record is never changed or removed. */
@Entity('flaky_tests')
@Index('IDX_flaky_tests_project_test', ['project', 'test'])
export class FlakyTestEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'run_id', type: 'text' })
  runId!: string;

  @Column({ type: 'text' })
  project!: string;

  @Column({ type: 'text' })
  test!: string;

  /** The ref the failed and passed jobs ran on. */
  @Column({ type: 'text' })
  ref!: string;

  @Column({ type: 'text', nullable: true })
  seed!: string | null;

  @Column({ name: 'failed_log', type: 'text' })
  failedLog!: string;

  @Column({ name: 'passed_log', type: 'text' })
  passedLog!: string;

  @Column({ name: 'created_at', type: 'text' })
  createdAt!: string;
}
