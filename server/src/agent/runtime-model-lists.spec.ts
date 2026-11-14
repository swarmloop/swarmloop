import { mkdtemp, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { testEnv } from '../config/env.spec-helpers';
import { runtimeFor } from '../integrations/agent-runtime/agent-runtime.registry';
import { loadRuntimeModelIds, warmModelLists } from './runtime-model-lists';

const NOW = Date.parse('2026-11-13T10:00:00Z');
const LIST = 'grok-4.7 - Grok 4.7\ngrok-4.7-high - Grok 4.7 High\n';

describe('runtime model lists', () => {
  afterEach(() => runtimeFor('cursor').useModelList(''));

  it('gives the runtime the levels of the list it read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-lists-'));
    await loadRuntimeModelIds(root, runtimeFor('cursor'), NOW, () => Promise.resolve(LIST));
    expect(runtimeFor('cursor').efforts('grok-4.7')).toEqual(['high']);
    expect(JSON.parse(await readFile(join(root, 'data', 'model-list-cursor.json'), 'utf8'))).toMatchObject({
      output: LIST,
    });
  });

  it('fails with the runtime and the reason when no list can be read', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-lists-'));
    const env = testEnv({ AGENTS_PLAN: 'cursor:grok-4.7:high' });
    await expect(
      warmModelLists(env, root, NOW, () => () => Promise.reject(new Error('docker is down'))),
    ).rejects.toThrow(/cursor.*name an effort.*empty/);
  });

  it('reads no list for an env that names no effort, or a runtime with no list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-lists-'));
    const lister = () => () => Promise.reject(new Error('must not run'));
    await expect(
      warmModelLists(testEnv({ AGENTS_PLAN: 'cursor:grok-4.7' }), root, NOW, lister),
    ).resolves.toBeUndefined();
    await expect(warmModelLists(testEnv({ AGENTS_PLAN: 'claude:m:high' }), root, NOW, lister)).resolves.toBeUndefined();
  });

  it('reads nothing for a runtime that has no lister, because it has no credential', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-lists-'));
    await expect(
      warmModelLists(testEnv({ AGENTS_PLAN: 'cursor:grok-4.7:high' }), root, NOW, () => null),
    ).resolves.toBeUndefined();
  });

  it('lets an env agent with a level pass once its list is loaded', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-lists-'));
    await warmModelLists(
      testEnv({ AGENTS_PLAN: 'cursor:grok-4.7:high' }),
      root,
      NOW,
      () => () => Promise.resolve(LIST),
    );
    expect(runtimeFor('cursor').efforts('grok-4.7')).toEqual(['high']);
  });

  it('hands a cached list to its runtime even when no env agent names a level', async () => {
    const root = await mkdtemp(join(tmpdir(), 'runtime-lists-'));
    await loadRuntimeModelIds(root, runtimeFor('cursor'), NOW, () => Promise.resolve(LIST));
    runtimeFor('cursor').useModelList('');
    const lister = () => () => Promise.reject(new Error('must not run'));
    await warmModelLists(testEnv({ AGENTS_PLAN: 'cursor:grok-4.7' }), root, NOW, lister);
    expect(runtimeFor('cursor').efforts('grok-4.7')).toEqual(['high']);
  });
});
