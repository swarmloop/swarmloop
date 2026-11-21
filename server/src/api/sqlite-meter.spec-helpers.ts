import type { DataSource } from 'typeorm';

interface Statement {
  [method: string]: unknown;
}

interface Handle {
  prepare(source: string): Statement;
}

export interface SqliteMeter {
  measure<T>(callback: () => Promise<T>): Promise<{ result: T; statements: number; characters: number }>;
}

const READS = new Set(['all', 'get', 'iterate', 'run']);
const CHAINS = new Set(['raw', 'pluck', 'expand', 'bind', 'safeIntegers']);

/** The characters in the string values of one row: an object, an array from raw mode, or a plucked value. */
function rowCharacters(row: unknown): number {
  if (typeof row === 'string') {
    return row.length;
  }
  if (row === null || typeof row !== 'object') {
    return 0;
  }
  return Object.values(row).reduce<number>((sum, value) => sum + (typeof value === 'string' ? value.length : 0), 0);
}

/** The characters in what `all` returns (a list of rows) or `get` returns (one row). */
function rowsCharacters(rows: unknown): number {
  return Array.isArray(rows) ? rows.reduce<number>((sum, row) => sum + rowCharacters(row), 0) : rowCharacters(rows);
}

/**
 * Wraps the test database's better-sqlite3 handle so that, inside `measure`, every statement run and every string
 * character SQLite returns is counted. Install it before the first query: it stays on until the database closes.
 */
export function meterDatabase(data: DataSource): SqliteMeter {
  const handle = (data.driver as unknown as { databaseConnection: Handle }).databaseConnection;
  const realPrepare = handle.prepare.bind(handle);
  let counting = false;
  let statements = 0;
  let characters = 0;

  function wrap(real: Statement): Statement {
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
          statements += 1;
          if (property === 'iterate') {
            return counted(result as Iterable<unknown>);
          }
          characters += rowsCharacters(result);
          return result;
        };
      },
    });
    return proxy;
  }

  function* counted(rows: Iterable<unknown>): Generator<unknown> {
    for (const row of rows) {
      characters += rowCharacters(row);
      yield row;
    }
  }

  handle.prepare = (source: string) => wrap(realPrepare(source));

  return {
    async measure(callback) {
      statements = 0;
      characters = 0;
      counting = true;
      try {
        const result = await callback();
        return { result, statements, characters };
      } finally {
        counting = false;
      }
    },
  };
}
