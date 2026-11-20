import type { RunEta } from './eta';
import type { InterruptionNote } from './interruption';
import type { RunState, StateReason } from './run-state';
import type { SubtaskStatus } from './subtask';

/** One task of a split plan, as the run page shows it. */
export interface TaskEntry {
  id: string;
  /** The position of the task in the plan, the order the run list shows its tasks in. */
  index: number;
  title: string;
  files: string[];
  proof: string;
  depends: string[];
  status: SubtaskStatus;
  /** A rough estimate of the time left; absent when the task has none. */
  eta?: RunEta;
  /** What the task waits on or was told: for a running task whose own run waits, the live text of that run's reason. */
  note?: string;
  /** For a waiting task: the titles of the dependencies that have not merged yet. `[]` means it waits only for a free slot. */
  waitsFor?: string[];
  /** The subtask's own run, once it has started. `stateReason` tells a wait for a person from a wait that ends by itself. */
  run?: {
    key: string;
    state: RunState;
    stateReason?: StateReason | null;
    currentStep: string;
    usd: number;
    durationMs: number;
    /** Set when the run's latest visit was cut by a server restart. */
    interruption?: InterruptionNote;
    /** Set once the task has a merge request: what it changed, and whether its proof held (checks, review and CI passed). `null` while that is open. */
    result?: { files: string[]; proofMet: boolean | null };
  };
}
