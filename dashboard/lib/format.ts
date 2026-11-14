export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${rest}s`;
  }
  return `${rest}s`;
}

export function money(usd: number): string {
  if (usd === 0) {
    return '$0';
  }
  return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

export function count(value: number): string {
  return new Intl.NumberFormat('en').format(value);
}

export function tokens(value: number): string {
  const n = Math.round(value);
  if (n < 1000) {
    return String(n);
  }
  const thousands = Math.round(n / 1000);
  if (thousands < 1000) {
    return `${thousands}k`;
  }
  const text = (Math.round(n / 100_000) / 10).toFixed(1);
  return text.endsWith('.0') ? `${text.slice(0, -2)}M` : `${text}M`;
}

export function memory(bytes: number): string {
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(
    date,
  );
}

/** The time of day of an ISO time, `HH:MM:SS`. */
export function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : new Intl.DateTimeFormat('en-GB', { timeStyle: 'medium' }).format(date);
}

/** The time of day of an ISO time in the viewer's time, `HH:MM`. */
export function localTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : new Intl.DateTimeFormat('en-GB', { timeStyle: 'short' }).format(date);
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Whole local calendar days from `iso` to `now`, or null for an invalid time. */
function daysAgo(iso: string, now: Date): number | null {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  const day = (value: Date): number => Date.UTC(value.getFullYear(), value.getMonth(), value.getDate());
  return Math.round((day(now) - day(date)) / DAY_MS);
}

function monthDay(iso: string): string {
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric' }).format(new Date(iso));
}

/** How long ago a time was: `now`, `3m`, `2h` the same day, `yesterday`, then `Nov 9`. */
export function relative(iso: string, now: Date): string {
  const days = daysAgo(iso, now);
  if (days === null) {
    return iso;
  }
  const minutes = Math.floor((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (days <= 0 && minutes < 1) {
    return 'now';
  }
  if (days <= 0) {
    return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h`;
  }
  return days === 1 ? 'yesterday' : monthDay(iso);
}

/** The heading of a day group: `Today`, `Yesterday` or `Nov 10`. */
export function dayLabel(iso: string, now: Date): string {
  const days = daysAgo(iso, now);
  if (days === null) {
    return iso;
  }
  if (days <= 0) {
    return 'Today';
  }
  return days === 1 ? 'Yesterday' : monthDay(iso);
}
