import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { CODE_HOST_ENV_KEYS, CODE_HOST_LOGIN_ENV_KEYS } from '../../config/env.schema';
import type { CodeHostEnv } from './abstract-code-host';
import { codeHostAdapters } from './code-host-adapters';

describe('code host adapters', () => {
  it('loads exactly the folders that hold an index module', () => {
    const folders = readdirSync(__dirname, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => ['index.ts', 'index.js'].some((file) => existsSync(join(__dirname, entry.name, file))))
      .map((entry) => entry.name)
      .sort();
    expect(codeHostAdapters().map((adapter) => adapter.name)).toEqual(folders);
    expect(folders).toEqual(['github', 'gitlab']);
  });

  it('tries gitlab before github when it builds a push url', () => {
    const ordered = [...codeHostAdapters()].sort((a, b) => a.pushOrder - b.pushOrder);
    expect(ordered.map((adapter) => adapter.name)).toEqual(['gitlab', 'github']);
  });

  it('creates repositories on github by default', () => {
    expect(
      codeHostAdapters()
        .filter((adapter) => adapter.createsByDefault)
        .map((adapter) => adapter.name),
    ).toEqual(['github']);
  });

  it('keeps the list it found', () => {
    expect(codeHostAdapters()).toBe(codeHostAdapters());
  });

  it('builds the api url of each host under its own base', () => {
    for (const adapter of codeHostAdapters()) {
      const env = { [adapter.baseKey]: 'https://forge.example' } as unknown as CodeHostEnv;
      expect(new URL(adapter.endpoints(env).api).origin).toBe('https://forge.example');
    }
  });

  it('lists the env keys of the hosts in the order the env has always read them', () => {
    const adapters = codeHostAdapters();
    expect(
      [...adapters].sort((a, b) => a.pushOrder - b.pushOrder).flatMap((adapter) => [adapter.baseKey, adapter.tokenKey]),
    ).toEqual([...CODE_HOST_ENV_KEYS]);
    expect(adapters.flatMap(({ clientEnvKeys }) => [clientEnvKeys.clientId, clientEnvKeys.clientSecret])).toEqual([
      ...CODE_HOST_LOGIN_ENV_KEYS,
    ]);
  });
});
