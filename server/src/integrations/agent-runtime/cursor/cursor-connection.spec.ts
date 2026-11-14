import { readFile } from 'fs/promises';
import { join } from 'path';
import { DataSource } from 'typeorm';
import { call, start, type Started } from '../../../auth/connection-catalog.spec-helpers';
import { useCachedModelList } from '../../../agent/runtime-model-lists';
import { runtimeFor } from '../agent-runtime.registry';
import type { CursorRuntime } from './cursor.runtime';

const KEY = 'crsr-key-1234';
const LIST = 'grok-4.7 - Grok 4.7\ncomposer-2 - Composer 2\n';

describe('the Cursor connection', () => {
  let started: Started;
  const cursor = () => runtimeFor('cursor') as CursorRuntime;
  const put = () => call(`${started.url}/cursor`, 'alice', 'PUT', { fields: { CURSOR_API_KEY: KEY } });
  const rows = () => started.app.get(DataSource).query<Record<string, unknown>[]>('SELECT * FROM integration_secrets');
  const cacheFile = () => join(started.root, 'data', 'model-list-cursor.json');
  const cached = () => readFile(cacheFile(), 'utf8');

  afterEach(async () => {
    cursor().setModelIds([]);
    await started.close();
  });

  it('stores a key whose model list came back, and caches the list for the Settings menu', async () => {
    started = await start({}, undefined, LIST);
    const response = await put();
    expect(await response.json()).toMatchObject({ id: 'cursor', status: 'connected', last4: '1234' });
    expect(await rows()).toMatchObject([{ connection: 'cursor' }]);
    expect(await cached()).toContain('composer-2');
    await useCachedModelList(started.root, cursor(), Date.now());
    expect(cursor().listLoaded()).toBe(true);
  });

  it('refuses a key when the list is empty, and stores and caches nothing', async () => {
    started = await start({}, undefined, '');
    const response = await put();
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: 'Cursor listed no models' });
    expect(await rows()).toEqual([]);
    await expect(cached()).rejects.toThrow();
  });
});
