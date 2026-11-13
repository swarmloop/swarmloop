import type { StoredAgents } from '../contract/api';
import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

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

  /** What the last pass of a split parent saw of its subtasks; null before the first pass. */
  @Column({ name: 'subtask_fingerprint', type: 'text', nullable: true })
  subtaskFingerprint!: string | null;

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

  /** JSON `MergeOutcome` of a done run whose merge requests ended. Null while it waits for a merge. */
  @Column({ name: 'merge_outcome', type: 'text', nullable: true })
  mergeOutcome!: string | null;

  /** When the merge watch first saw the run done. The 30-day wait and the time to merge count from it. */
  @Column({ name: 'done_at', type: 'text', nullable: true })
  doneAt!: string | null;

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

  /** The starter's agent lists as they were when the run started. Never in an HTTP run payload. Null means env. */
  @Column({ type: 'simple-json', nullable: true })
  agents!: StoredAgents | null;

  /** ISO time the plan became a split, from when the parent's agents run at the epic effort. Null for any other run. */
  @Column({ name: 'epic_at', type: 'text', nullable: true })
  epicAt!: string | null;
}
