const FENCE = '```';

/** The log of a reviewer whose final message ends with its result block, then its exit line. */
export function reviewLog(decision: 'ok' | 'return', ending = 'process exited 0'): string {
  const text = `notes\n\n${FENCE}json\n${JSON.stringify({ decision, review: 'notes', summary: [] })}\n${FENCE}`;
  return `${JSON.stringify({ type: 'result', result: text })}\n${ending}`;
}
