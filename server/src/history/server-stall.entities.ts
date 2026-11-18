import { Column, Entity, Index, PrimaryColumn, PrimaryGeneratedColumn } from 'typeorm';
import type { ServerStallKind } from '../contract/server-stall';

/** One time the server stopped answering, with what ran then. A record is never changed. */
@Entity('server_stalls')
@Index('IDX_server_stalls_started_at', ['startedAt'])
export class ServerStallEntity {
  @PrimaryGeneratedColumn()
  id!: number;

  @Column({ name: 'started_at', type: 'text' })
  startedAt!: string;

  @Column({ name: 'duration_ms', type: 'integer' })
  durationMs!: number;

  @Column({ type: 'text' })
  kind!: ServerStallKind;

  @Column({ name: 'running_agents', type: 'integer' })
  runningAgents!: number;

  @Column({ name: 'running_checks', type: 'integer' })
  runningChecks!: number;

  @Column({ name: 'running_setups', type: 'integer' })
  runningSetups!: number;

  /** The sum of the containers' CPU from their last samples, in percent of one core. */
  @Column({ name: 'cpu_percent', type: 'real' })
  cpuPercent!: number;

  @Column({ name: 'memory_bytes', type: 'integer' })
  memoryBytes!: number;

  @Column({ name: 'vm_cpus', type: 'integer', nullable: true })
  vmCpus!: number | null;

  @Column({ name: 'vm_memory_bytes', type: 'integer', nullable: true })
  vmMemoryBytes!: number | null;

  /** The last request, step or timer callback the main loop entered before a server-blocked stall. */
  @Column({ type: 'text', nullable: true })
  entered!: string | null;
}

/** Requests that took over a second, counted per route. */
@Entity('slow_requests')
export class SlowRequestEntity {
  @PrimaryColumn({ type: 'text' })
  route!: string;

  @Column({ type: 'integer' })
  count!: number;

  @Column({ name: 'total_ms', type: 'integer' })
  totalMs!: number;

  @Column({ name: 'longest_ms', type: 'integer' })
  longestMs!: number;

  @Column({ name: 'last_at', type: 'text' })
  lastAt!: string;
}
