import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { Test } from '@nestjs/testing';

import { SwarmloopConfigModule } from '../config/config.module';
import { AppConfig } from '../config/env';
import { freeBytes } from '../core/free-bytes';

import { writeEnvOverrides } from './env.spec-helpers';

describe('writeEnvOverrides', () => {
  let root: string;
  const saved = { ...process.env };

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'env-overrides-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    process.env = { ...saved };
  });

  async function boot(): Promise<AppConfig> {
    const app = await Test.createTestingModule({
      imports: [SwarmloopConfigModule.forRoot(join(root, '.env'))],
    }).compile();
    return app.get(AppConfig);
  }

  it('writes only the supplied line and the rest comes from defaults.env', async () => {
    delete process.env.MAX_RETURNS;
    delete process.env.MAX_AGENT_CALLS;
    await writeEnvOverrides(root, { MAX_RETURNS: '3' });

    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('MAX_RETURNS=3\n');
    const { env } = await boot();
    expect(env.MAX_RETURNS).toBe(3);
    expect(env.MAX_AGENT_CALLS).toBe(100);
  });

  it('keeps the shipped MIN_FREE_GB while the free-space reading stays fixed', async () => {
    await writeEnvOverrides(root, {});

    const { env } = await boot();
    expect(env.MIN_FREE_GB).toBe(10);
    expect(await freeBytes(root)).toBe(100 * 1024 ** 3);
  });
});
