import { AsyncLocalStorage } from 'async_hooks';
import { realpathSync } from 'fs';
import { resolve } from 'path';

/** The tail of each worktree's queue. An entry goes when its tail settles. */
const tails = new Map<string, Promise<void>>();
/** The token of the operation that holds each worktree now. */
const holders = new Map<string, symbol>();
/** The tokens of the locks the current operation holds. */
const storage = new AsyncLocalStorage<ReadonlySet<symbol>>();

function keyOf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * Runs `fn` as the only writer of one worktree, first come first served. A call made inside a held
 * section on the same worktree runs at once. Rule for every user: a held section never awaits work
 * that runs in another async context on the same worktree, and never holds an agent launch.
 */
export function withWorktree<T>(path: string, fn: () => Promise<T>): Promise<T> {
  return lockKey(keyOf(path), fn);
}

/** Runs `fn` holding every path, taken in sorted order so that two callers cannot wait on each other. */
export function withWorktrees<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
  const keys = [...new Set(paths.map(keyOf))].sort();
  return keys.reduceRight<() => Promise<T>>((inner, key) => () => lockKey(key, inner), fn)();
}

function lockKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const held = storage.getStore() ?? new Set<symbol>();
  const holder = holders.get(key);
  if (holder !== undefined && held.has(holder)) {
    return fn();
  }
  const token = Symbol(key);
  const run = async (): Promise<T> => {
    holders.set(key, token);
    try {
      return await storage.run(new Set([...held, token]), fn);
    } finally {
      if (holders.get(key) === token) {
        holders.delete(key);
      }
    }
  };
  const current = (tails.get(key) ?? Promise.resolve()).then(run);
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, settled);
  void settled.then(() => {
    if (tails.get(key) === settled) {
      tails.delete(key);
    }
  });
  return current;
}
