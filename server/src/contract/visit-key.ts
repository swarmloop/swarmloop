/** The key of a stored visit: its `step_stats` id. */
export function visitKey(id: number): string {
  return `visit-${id}`;
}

/** The key of a visit that is not stored yet: the step and the attempt it shows. */
export function liveVisitKey(step: string, attempt: number): string {
  return `live-${step}-${attempt}`;
}
