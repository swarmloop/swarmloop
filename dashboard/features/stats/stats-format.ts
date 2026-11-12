/** Dollars short enough for a tile or an axis: $0, $7.32, $183, $1.2k. */
export function usd(value: number): string {
  if (value === 0) {
    return '$0';
  }
  if (value >= 1000) {
    return `$${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k`;
  }
  if (value >= 100) {
    return `$${Math.round(value)}`;
  }
  return value < 0.01 ? '<$0.01' : `$${value.toFixed(2)}`;
}

/** A large count: 950, 12k, 28M, 2.3B. */
export function big(value: number): string {
  const steps: [number, string][] = [
    [1e9, 'B'],
    [1e6, 'M'],
    [1e3, 'k'],
  ];
  for (const [size, suffix] of steps) {
    if (value >= size) {
      const scaled = value / size;
      return `${scaled >= 10 ? Math.round(scaled) : scaled.toFixed(1).replace(/\.0$/, '')}${suffix}`;
    }
  }
  return String(Math.round(value));
}

/** Working time: 45 min, 2.5 h, 159 h. */
export function hours(ms: number): string {
  const minutes = ms / 60_000;
  if (minutes < 60) {
    return `${Math.round(minutes)} min`;
  }
  const value = minutes / 60;
  return `${value >= 10 ? Math.round(value) : value.toFixed(1)} h`;
}

/** A share in whole percent, or a dash when there is nothing to share. */
export function percent(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : '—';
}

const DAY = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const WEEKDAY = new Intl.DateTimeFormat('en', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });

/** `2026-11-03` as `Nov 3`. The day is already local: it is read as UTC so nothing shifts it again. */
export function dayLabel(day: string): string {
  return DAY.format(Date.parse(`${day}T00:00:00Z`));
}

/** `2026-11-03` as `Tue, Nov 3`. */
export function longDayLabel(day: string): string {
  return WEEKDAY.format(Date.parse(`${day}T00:00:00Z`));
}

/** Round axis ticks from 0 to at least `max`: 0, 5, 10, 15 or 0, 50, 100. Counts get whole steps. */
export function ticks(max: number, { count = 4, whole = false }: { count?: number; whole?: boolean } = {}): number[] {
  if (max <= 0) {
    return [0, 1];
  }
  const raw = max / count;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const nice = [1, 2, 2.5, 5, 10].map((factor) => factor * magnitude).find((candidate) => candidate >= raw) ?? raw;
  const step = whole ? Math.max(1, Math.ceil(nice)) : nice;
  const result: number[] = [];
  for (let value = 0; value < max + step; value += step) {
    result.push(Math.round(value * 1000) / 1000);
    if (value >= max) {
      break;
    }
  }
  return result;
}

const KIND_NAMES: Record<string, string> = { checks: 'checks', review: 'reviewers', pipeline: 'CI' };

/** Returns by the kind that sent them back, as `40 from checks, 34 from reviewers, 31 from CI`. Those three always show; another kind (a new loop step) follows under its own counter. */
export function returnsByKind(kinds: { kind: string; returns: number }[], separator: string): string {
  const counts = new Map(Object.keys(KIND_NAMES).map((kind) => [kind, 0]));
  kinds.forEach(({ kind, returns }) => counts.set(kind, (counts.get(kind) ?? 0) + returns));
  return [...counts].map(([kind, returns]) => `${returns} from ${KIND_NAMES[kind] ?? kind}`).join(separator);
}
