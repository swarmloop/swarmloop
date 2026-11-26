import type { DataSource } from 'typeorm';

interface Column {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
}

export type Row = Record<string, string | number | null>;

/** Inserts a row into an old database, filling the NOT NULL columns it does not name with 0 or an empty text. */
export async function insert(dataSource: DataSource, table: string, values: Row): Promise<void> {
  const columns = await dataSource.query<Column[]>(`PRAGMA table_info("${table}")`);
  const row: Row = { ...values };
  for (const column of columns) {
    if (column.name === 'id' || column.name in row || column.notnull === 0 || column.dflt_value !== null) {
      continue;
    }
    row[column.name] = /int/i.test(column.type) ? 0 : '';
  }
  const names = Object.keys(row);
  await dataSource.query(
    `INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`,
    names.map((name) => row[name]),
  );
}
