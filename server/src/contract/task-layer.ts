import type { SubtaskStatus } from './subtask';

/** The tasks that can start together once the layers before them are done. */
export interface TaskLayer {
  layer: number;
  tasks: {
    id: string;
    title: string;
    files: string[];
    proof: string;
    depends: string[];
    status: SubtaskStatus;
    note?: string;
    /** The subtask's own run, once it has started. */
    run?: { key: string; currentStep: string; usd: number; durationMs: number };
  }[];
}
