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
  return new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date);
}
