/** The placeholders of a list of values for a raw query. */
export function placeholders(values: unknown[]): string {
  return values.map(() => '?').join(', ');
}
