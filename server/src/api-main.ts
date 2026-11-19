import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { assertAgents } from './config/agents';
import { AppConfig } from './config/env';
import { applySettings, assertSettings, readSettings } from './config/load-env';
import { RequestTiming } from './api/request-timing';
import { secureHttp } from './api/request-guard';
import { Clock } from './core/clock';
import { warmRuntimeModelLists } from './pipeline/model-lists.bootstrap';
import { Housekeeping } from './pipeline/housekeeping';
import { ServerStallWatch } from './pipeline/server-stalls/server-stall-watch';
import { BacklogScheduler } from './pipeline/backlog/backlog-scheduler';
import { BacklogPlanner } from './pipeline/backlog/planner/backlog-planner';
import { Reconciler } from './pipeline/reconciler';
import { WalCheckpoint } from './history/wal-checkpoint';
import { bindRefusal } from './auth/bind-check';
import { HostAppsService } from './auth/host-apps.service';
import { codeHostAdapters } from './integrations/code-host/code-host-adapters';
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
    const refusal = bindRefusal(
      env,
      codeHostAdapters().some((adapter) => apps.find(adapter.name) !== null),
    );
    if (refusal) {
      await app.close();
      fail(refusal);
      return;
    }
    app.use(app.get(RequestTiming).middleware());
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
    app.get(BacklogScheduler).schedule();
    await app.get(BacklogPlanner).start();
    app.get(WalCheckpoint).schedule();
    await app.get(ServerStallWatch).start();
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
