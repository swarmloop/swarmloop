import type { DataSource } from 'typeorm';

interface Statement {
  [method: string]: unknown;
}

interface Handle {
  prepare(source: string): Statement;
}

interface Measure<T> {
  result: T;
  statements: number;
  characters: number;
  /** The SQL of every statement run, in order. */
  sources: string[];
  /** Every string value SQLite returned. */
  strings: string[];
}

export interface SqliteMeter {
  measure<T>(callback: () => Promise<T>): Promise<Measure<T>>;
}

const READS = new Set(['all', 'get', 'iterate', 'run']);
const CHAINS = new Set(['raw', 'pluck', 'expand', 'bind', 'safeIntegers']);

/** The string values of one row: an object, an array from raw mode, or a plucked value. */
function rowStrings(row: unknown): string[] {
  if (typeof row === 'string') {
    return [row];
  }
  if (row === null || typeof row !== 'object') {
    return [];
  }
  return Object.values(row).filter((value): value is string => typeof value === 'string');
}

/** The string values in what `all` returns (a list of rows) or `get` returns (one row). */
function rowsStrings(rows: unknown): string[] {
  return Array.isArray(rows) ? rows.flatMap(rowStrings) : rowStrings(rows);
}

/**
 * Wraps the test database's better-sqlite3 handle so that, inside `measure`, every statement run and every string
 * SQLite returns is recorded. Install it before the first query: it stays on until the database closes.
 */
export function meterDatabase(data: DataSource): SqliteMeter {
  const handle = (data.driver as unknown as { databaseConnection: Handle }).databaseConnection;
  const realPrepare = handle.prepare.bind(handle);
  let counting = false;
  let sources: string[] = [];
  let strings: string[] = [];

  function wrap(real: Statement, source: string): Statement {
    const proxy: Statement = new Proxy(real, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== 'function' || typeof property !== 'string') {
          return value;
        }
        return (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args);
          if (CHAINS.has(property) && result === target) {
            return proxy;
          }
          if (!READS.has(property) || !counting) {
            return result;
          }
          sources.push(source);
          if (property === 'iterate') {
            return counted(result as Iterable<unknown>);
          }
          strings.push(...rowsStrings(result));
          return result;
        };
      },
    });
    return proxy;
  }

  function* counted(rows: Iterable<unknown>): Generator<unknown> {
    for (const row of rows) {
      strings.push(...rowStrings(row));
      yield row;
    }
  }

  handle.prepare = (source: string) => wrap(realPrepare(source), source);

  return {
    async measure(callback) {
      sources = [];
      strings = [];
      counting = true;
      try {
        const result = await callback();
        const characters = strings.reduce((sum, value) => sum + value.length, 0);
        return { result, statements: sources.length, characters, sources, strings };
      } finally {
        counting = false;
      }
    },
  };
}
