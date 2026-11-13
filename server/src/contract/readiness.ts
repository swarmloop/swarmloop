/** What swarmloop's heavy work takes of the machine, against what the budget allows. All zero capacity means no limit is known. */
export interface MachineLoad {
  capacityCpus: number;
  capacityMemoryBytes: number;
  usedCpus: number;
  usedMemoryBytes: number;
  /** The labels of the work that runs now. */
  running: string[];
  /** The labels of the work that waits, first in line first. */
  waiting: string[];
}
