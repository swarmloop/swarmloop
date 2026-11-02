import 'reflect-metadata';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { join } from 'path';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { readEnv } from './config/env';
import { assertEnvFile } from './config/load-env';
import { resolveRepoRoot } from './config/repo-root';
import { PANEL_ORIGINS } from './live/origins';

async function bootstrap(): Promise<void> {
  const envError = assertEnvFile(join(resolveRepoRoot(undefined, __dirname), '.env'));
  if (envError) {
    fail(envError);
    return;
  }
  const { ApiModule } = await import('./api/api.module');
  try {
    const app = await NestFactory.create(ApiModule, { logger: ['error', 'warn', 'log'] });
    app.enableCors({ origin: PANEL_ORIGINS });
    app.useWebSocketAdapter(new IoAdapter(app));
    const env = readEnv(app.get(ConfigService));
    await app.listen(env.SWARMLOOP_API_PORT, env.SWARMLOOP_API_HOST);
  } catch (error) {
    fail(error);
  }
}

function fail(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

void bootstrap();
