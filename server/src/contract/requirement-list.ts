/** One thing the input asks for. Its id never changes for the life of a run. */
export interface Requirement {
  id: string;
  text: string;
}

/** A requirement with the plan items and tasks that cover it. */
export interface CoveredRequirement {
  id: string;
  text: string;
  items: string[];
}
