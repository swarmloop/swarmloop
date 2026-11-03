import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { DataSource, DataSourceOptions } from 'typeorm';
import {
  AgentExchangeEntity,
  CheckoutEntity,
  DenyPathEntity,
  DocumentEntity,
  FlowEntity,
  HttpCallEntity,
  LoopEventEntity,
  PasteEntity,
  ResourceSampleEntity,
  RunEntity,
  StepStatEntity,
} from '../entities';
import { historyDatabaseOptions } from '../history.module';

async function withDataSource<T>(options: DataSourceOptions, use: (dataSource: DataSource) => Promise<T>): Promise<T> {
  const dataSource = new DataSource(options);
  await dataSource.initialize();
  try {
    return await use(dataSource);
  } finally {
    await dataSource.destroy();
  }
}

async function insertOneRowPerTable(dataSource: DataSource): Promise<void> {
  const at = '2026-01-01T00:00:00.000Z';
  await dataSource.getRepository(RunEntity).insert({
    key: 'run-1',
    status: 'running',
    currentStep: 'research',
    runtime: 'cursor',
    requirementsVia: 'direct',
    issueTracker: 'jira',
    codeHost: 'gitlab',
    createdAt: at,
    updatedAt: at,
  });
  await dataSource.getRepository(DocumentEntity).insert({
    runId: 1,
    stepStatId: 1,
    kind: 'plan',
    attempt: 1,
    body: 'body',
    path: 'plan.md',
    createdAt: at,
  });
  await dataSource.getRepository(StepStatEntity).insert({
    runId: 1,
    step: 'research',
    attempt: 1,
    startedAt: at,
    finishedAt: at,
    durationMs: 1000,
    status: 'done',
  });
  await dataSource.getRepository(ResourceSampleEntity).insert({
    stepStatId: 1,
    sampledAt: at,
    cpuPercent: 12.5,
    rssBytes: 1024,
  });
  await dataSource.getRepository(AgentExchangeEntity).insert({
    stepStatId: 1,
    model: 'model',
    startedAt: at,
    finishedAt: at,
    durationMs: 1000,
    requestText: 'request',
    responseText: 'response',
  });
  await dataSource.getRepository(LoopEventEntity).insert({
    runId: 1,
    counter: 'returns',
    attempt: 1,
    reason: 'reason',
    createdAt: at,
  });
  await dataSource.getRepository(HttpCallEntity).insert({
    runId: 1,
    stepStatId: 1,
    provider: 'gitlab',
    method: 'GET',
    url: 'https://gitlab.example',
    durationMs: 100,
    createdAt: at,
  });
  await dataSource.getRepository(PasteEntity).insert({ runKey: 'run-1', url: 'https://paste.example', body: 'body' });
  await dataSource.getRepository(CheckoutEntity).insert({ name: 'main', path: '/work/main' });
  await dataSource.getRepository(DenyPathEntity).insert({ pattern: '*.secret' });
  await dataSource.getRepository(FlowEntity).insert({ runId: 1, phases: '[]', createdAt: at });
}

async function snapshot(dataSource: DataSource) {
  const schema = await dataSource.query(
    `SELECT type, name, tbl_name, sql FROM sqlite_master WHERE tbl_name <> 'migrations' ORDER BY type, name`,
  );
  const rows: Record<string, unknown[]> = {};
  for (const metadata of dataSource.entityMetadatas) {
    rows[metadata.tableName] = await dataSource.query(`SELECT * FROM "${metadata.tableName}" ORDER BY id`);
  }
  return { schema, rows };
}

describe('history migrations on a database built by synchronize', () => {
  it('leave the schema and the rows unchanged', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-compat-'));
    try {
      const before = await withDataSource(
        { ...historyDatabaseOptions(root), synchronize: true, migrationsRun: false },
        async (dataSource) => {
          await insertOneRowPerTable(dataSource);
          return snapshot(dataSource);
        },
      );
      const after = await withDataSource(historyDatabaseOptions(root), snapshot);
      expect(after).toEqual(before);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
