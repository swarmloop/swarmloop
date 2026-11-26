/** A relaunch after a rebase: why the run's steps run again, which ones, and whether they have run on the new head. */
export interface RelaunchView {
  /** When the relaunch was made, as an ISO time. */
  at: string;
  /** The reason in words, with a capital first letter. */
  reason: string;
  /** The phases the relaunch runs again. */
  phases: string[];
  /** The step names the relaunch runs again. */
  steps: string[];
  /** True until each of those steps has run on the new head. */
  open: boolean;
}
