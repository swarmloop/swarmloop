export const MINUTE_MS = 60 * 1000;
const DAY_MS = 24 * 60 * MINUTE_MS;

const dayNames = new Map<number, string>();

/** The local day of an ISO time, `YYYY-MM-DD`. Each distinct day is formatted once. */
export function localDay(iso: string | number, tzOffset: number): string {
  const ms = typeof iso === 'number' ? iso : Date.parse(iso);
  const index = Math.floor((ms - tzOffset * MINUTE_MS) / DAY_MS);
  let name = dayNames.get(index);
  if (name === undefined) {
    name = new Date(index * DAY_MS).toISOString().slice(0, 10);
    dayNames.set(index, name);
  }
  return name;
}
