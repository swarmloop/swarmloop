/** The key under which the files of a backlog's messages are kept. */
export function backlogMessageKey(backlogId: number): string {
  return `backlog-${backlogId}-messages`;
}
