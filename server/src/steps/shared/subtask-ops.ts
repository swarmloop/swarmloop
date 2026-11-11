import type { RunEntity } from '../../history/entities';
import type { Subtask } from '../../contract/subtask';

/**
 * What the split pass needs of the runs of its subtasks. It is a token: the pipeline layer provides it, so a step
 * never imports `pipeline` or `api`.
 */
export abstract class SubtaskOps {
  /** The waiting run of a task. It has no worktree until it starts. */
  abstract open(parent: RunEntity, task: Subtask): Promise<RunEntity>;
  /** Starts the run of a task that `open` made. A run that has started stays as it is. */
  abstract launch(parent: RunEntity, task: Subtask): Promise<void>;
  /** Resumes a subtask that a Stop left behind. */
  abstract resume(run: RunEntity): Promise<void>;
  /** The run of a task, when it has one. */
  abstract find(parent: RunEntity, taskId: string): Promise<RunEntity | null>;
  /** Says in the waiting run of a task what it waits for. */
  abstract waitFor(run: RunEntity, message: string): Promise<void>;
  /** True when no pipeline ran for the merge request of a subtask run. */
  abstract withoutCi(run: RunEntity): Promise<boolean>;
}
