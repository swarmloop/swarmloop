import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { join } from 'path';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { assertAgents } from './config/agents';
import { AppConfig } from './config/env';
import { assertEnvFile } from './config/load-env';
import { resolveRepoRoot } from './config/repo-root';
import { Housekeeping } from './pipeline/housekeeping';
import { Reconciler } from './pipeline/reconciler';
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
    app.enableShutdownHooks();
    app.enableCors({ origin: PANEL_ORIGINS });
    app.useWebSocketAdapter(new IoAdapter(app));
    const env = app.get(AppConfig).env;
    assertAgents(env);
    await app.listen(env.SWARMLOOP_API_PORT, env.SWARMLOOP_API_HOST);
    const housekeeping = app.get(Housekeeping);
    await housekeeping.startup();
    housekeeping.schedule();
    app.get(Reconciler).schedule();
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
