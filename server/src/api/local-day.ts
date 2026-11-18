export const MINUTE_MS = 60 * 1000;

/** The local day of an ISO time, `YYYY-MM-DD`. */
export function localDay(iso: string | number, tzOffset: number): string {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  return new Date(ms - tzOffset * MINUTE_MS).toISOString().slice(0, 10);
}
