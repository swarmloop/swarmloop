import { Test, type TestingModule } from '@nestjs/testing';
import { readFileSync } from 'fs';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { SwarmloopConfigModule } from './config.module';
import { AppConfig } from './env';
import { envSchema } from './env.schema';

/** Expectations deliberately do not use the production parser or loader. */
export function shippedDefaults(): Record<string, string> {
  return Object.fromEntries(
    readFileSync(join(__dirname, '../../..', 'defaults.env'), 'utf8')
      .split('\n')
      .filter((line) => /^[A-Z_]+=/.test(line))
      .map((line) => {
        const separator = line.indexOf('=');
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

export function validateSettings(values: Record<string, unknown>, options = {}) {
  const defined = Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
  return envSchema.validate({ ...shippedDefaults(), ...defined }, options);
}

/** Compile a file-backed configuration and release every resource, including on rejection. */
export async function compileWith(values?: Record<string, string | number>): Promise<AppConfig> {
  const saved = { ...process.env };
  const dir = await mkdtemp(join(__dirname, '.env-spec-'));
  const path = join(dir, '.env');
  let moduleRef: TestingModule | undefined;
  try {
    if (values)
      await writeFile(
        path,
        Object.entries(values)
          .map(([key, value]) => `${key}=${value}`)
          .join('\n'),
      );
    moduleRef = await Test.createTestingModule({ imports: [SwarmloopConfigModule.forRoot(path, {})] }).compile();
    return moduleRef.get(AppConfig);
  } finally {
    try {
      await moduleRef?.close();
    } finally {
      process.env = saved;
      await rm(dir, { recursive: true, force: true });
    }
  }
}
