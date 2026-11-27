/** What a run does with one repository: `read` has no work of its own, `publishing` has work whose branch, pipeline ref or merge request is not all made yet, `published` has all three. */
export type DeliveryState = 'read' | 'publishing' | 'published';

/** One repository of a run with what the run delivers of it. */
export interface DeliveryView {
  repo: string;
  state: DeliveryState;
}

/** A delivery entry as the run stores it; a published one also names its project on the code host. */
export interface DeliveryEntry extends DeliveryView {
  project?: string;
}
