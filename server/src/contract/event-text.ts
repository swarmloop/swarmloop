/** The result line of a step without the ISO time that older events carry in front of it. */
export function withoutTimestamp(line: string): string {
  return line.replace(/^\d{4}-\d{2}-\d{2}T\S+\s+/, '');
}
