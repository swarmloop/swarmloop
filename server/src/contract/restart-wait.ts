/** What a step says while the server waits for the agent a dead process started. `time` turns the stored time into the reader's local time. */
export function restartWaitSentence(at: string, time: (iso: string) => string): string {
  return `The server restarted at ${time(at)}. Waiting for the agent it had started to finish; then this step goes on by itself.`;
}

/** The line a chart shows when the server that measured the containers restarted and took no samples after. */
export const NO_SAMPLES_AFTER_RESTART = 'No samples: the server that measured these containers restarted.';
