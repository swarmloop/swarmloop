/** What swarmloop's heavy work takes of the machine, against what the budget allows. Zero memory capacity means no limit is known. */
export interface MachineLoad {
  capacityMemoryBytes: number;
  usedMemoryBytes: number;
  /** The labels of the work that runs now. */
  running: string[];
  /** The labels of the work that waits, first in line first. */
  waiting: string[];
}

export type ReadinessId =
  'docker' | 'arch' | 'images' | 'disk' | 'paths' | 'ports' | 'model-credential' | 'code-host-token';

export interface ReadinessItem {
  id: ReadinessId;
  status: 'ok' | 'warn' | 'fail';
  /** One line that says what was found. */
  line: string;
  /** One next step. For an `ok` item it says there is nothing to do. */
  action: string;
}

export interface ReadinessView {
  items: ReadinessItem[];
  /** When the report was built; null while the first one is still being built. */
  checkedAt: string | null;
  load: MachineLoad | null;
}
