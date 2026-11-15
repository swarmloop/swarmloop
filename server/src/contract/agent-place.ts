/** What a step reads while its agent waits for a free place among the agent containers of the whole server. */
export function agentPlaceText(busy: number, limit: number): string {
  return `Waiting for a free agent place (${busy} of ${limit} busy)`;
}
