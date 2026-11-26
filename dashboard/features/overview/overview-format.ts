import { duration } from '../../lib/format';

/** A count for people: `950`, `1.2k`, `3.4M`. */
export function compactCount(value: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(value).replace('K', 'k');
}

/** Dollars without cents: `$142`. */
export function wholeDollars(usd: number): string {
  return `$${new Intl.NumberFormat('en', { maximumFractionDigits: 0 }).format(usd)}`;
}

/** A share between 0 and 1 with one decimal: `86.2%`; `100%` only when the share is 1. */
export function percent(share: number): string {
  return share === 1 ? '100%' : `${(share * 100).toFixed(1)}%`;
}

/** A length of time; with hours the minutes have two digits: `12h 04m`. */
export function longDuration(ms: number): string {
  return duration(ms).replace(/^(\d+h) (\d)m$/, '$1 0$2m');
}

/** The returns of a run in words. Only a merged or done run says its returns were fixed. */
export function returnsWords(returns: number, finished: boolean): string {
  if (returns === 0) {
    return 'first pass';
  }
  if (!finished) {
    return returns === 1 ? '1 return' : `${returns} returns`;
  }
  return returns === 1 ? '1 return, fixed' : `${returns} returns, all fixed`;
}
