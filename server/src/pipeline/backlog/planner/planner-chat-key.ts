/** The key of the one planner chat of a backlog, which every turn of that backlog resumes. */
export function plannerChatKey(backlogId: number): string {
  return `backlog-${backlogId}-planner`;
}
