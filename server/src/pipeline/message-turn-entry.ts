/**
 * The way into a run's message turn, for the reconciler: `PipelineService` depends on the reconciler, so the
 * reconciler finds this entry through the module when it needs it, never through the service's class.
 */
export abstract class MessageTurnEntry {
  /** Takes the run's pending messages in the planner's turn; `outage` names the model host wait it answers. */
  abstract takeMessages(key: string, outage?: string): void;
}
