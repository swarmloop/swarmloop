/** A value that is one for every repository of a run, or answered per repository when the repositories differ. */
export type PerRepo<T> = T | ((repo: string) => T);

export function forRepo<T>(value: PerRepo<T>, repo: string): T {
  return typeof value === 'function' ? (value as (repo: string) => T)(repo) : value;
}
