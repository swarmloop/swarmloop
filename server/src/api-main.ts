import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { assertAgents } from './config/agents';
import { AppConfig } from './config/env';
import { applySettings, assertSettings, readSettings } from './config/load-env';
import { secureHttp } from './api/request-guard';
import { Clock } from './core/clock';
import { warmRuntimeModelLists } from './pipeline/model-lists.bootstrap';
import { Housekeeping } from './pipeline/housekeeping';
import { Reconciler } from './pipeline/reconciler';
import { bindRefusal } from './auth/bind-check';
import { HostAppsService } from './auth/host-apps.service';
import { allowedOrigins } from './live/origins';
import { SandboxService } from './sandbox/sandbox.service';

async function bootstrap(): Promise<void> {
  try {
    const settings = readSettings();
    const envError = assertSettings(settings);
    if (envError) {
      fail(envError);
      return;
    }
    applySettings(settings);
    const { ApiModule } = await import('./api/api.module');
    const app = await NestFactory.create<NestExpressApplication>(ApiModule, {
      logger: ['error', 'warn', 'log'],
      bodyParser: false,
    });
    const env = app.get(AppConfig).env;
    const apps = app.get(HostAppsService);
    const refusal = bindRefusal(env, apps.find('github') !== null || apps.find('gitlab') !== null);
    if (refusal) {
      await app.close();
      fail(refusal);
      return;
    }
    secureHttp(app, env.SWARMLOOP_PUBLIC_URL);
    app.enableShutdownHooks();
    app.enableCors({ origin: allowedOrigins(env.SWARMLOOP_PUBLIC_URL), credentials: true });
    app.useWebSocketAdapter(new IoAdapter(app));
    await warmRuntimeModelLists(env, app.get(SandboxService), app.get(Clock));
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
