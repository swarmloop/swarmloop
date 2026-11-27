/** The result line of a step without the ISO time that older events carry in front of it. */
export function withoutTimestamp(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/, '');
}

/** The first line of a step's result, without its time stamp: what the run page and the planner read as the step's outcome. */
export function resultLine(summary: string): string {
  return withoutTimestamp(summary).split('\n')[0]?.trim() ?? '';
}
