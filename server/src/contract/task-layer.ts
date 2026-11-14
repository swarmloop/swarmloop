import type { RunState, StateReason } from './run-state';
import type { SubtaskStatus } from './subtask';

/** The tasks that can start together once the layers before them are done. */
export interface TaskLayer {
  layer: number;
  tasks: {
    id: string;
    /** The position of the task in the plan, the order the run list shows its tasks in. */
    index: number;
    title: string;
    files: string[];
    proof: string;
    depends: string[];
    status: SubtaskStatus;
    note?: string;
    /** The subtask's own run, once it has started. `stateReason` tells a wait for a person from a wait that ends by itself. */
    run?: {
      key: string;
      state: RunState;
      stateReason?: StateReason | null;
      currentStep: string;
      usd: number;
      durationMs: number;
    };
  }[];
}
