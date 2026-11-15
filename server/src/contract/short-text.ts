/** The text itself when it fits `max` characters, else its first `max` characters and a '…' that marks the cut. */
export function shortLine(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
