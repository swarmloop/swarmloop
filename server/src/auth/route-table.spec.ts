import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants';
import { APP_GUARD } from '@nestjs/core';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import { AuthController } from './auth.controller';
import { AuthGuard } from './auth.guard';
import { ConnectionsController } from './connections.controller';
import { AuthModule } from './auth.module';
import { PUBLIC_KEY } from './public.decorator';

type Controller = { name: string; prototype: object };

function routes(controller: Controller): string[] {
  const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
  return Object.getOwnPropertyNames(controller.prototype)
    .filter((name) => name !== 'constructor')
    .map((name) => (controller.prototype as Record<string, unknown>)[name])
    .filter(
      (handler): handler is object => typeof handler === 'function' && Reflect.hasMetadata(PATH_METADATA, handler),
    )
    .map((handler) => `${base}/${String(Reflect.getMetadata(PATH_METADATA, handler))}`.replace(/^\/+/, ''));
}

describe('the route table', () => {
  // ApiModule builds its config at import time, so its source is read instead of loading it.
  const apiDir = join(__dirname, '../api');
  const apiModule = readFileSync(join(apiDir, 'api.module.ts'), 'utf8');
  let controllers: Controller[] = [];

  beforeAll(async () => {
    const files = readdirSync(apiDir).filter((file) => file.endsWith('.controller.ts'));
    const modules = await Promise.all(
      files.map((file) => import(join(apiDir, file)) as Promise<Record<string, Controller>>),
    );
    controllers = [
      ...modules.flatMap((loaded) => Object.values(loaded).filter((value) => value.name.endsWith('Controller'))),
      AuthController,
    ];
  });
  const open = (controller: Controller) => Reflect.getMetadata(PUBLIC_KEY, controller) === true;

  it('guards every route globally: ApiModule imports AuthModule, which registers the guard', () => {
    expect(controllers).toHaveLength(6);
    expect(apiModule).toMatch(/imports: \[[^\]]*\bAuthModule\b/);
    for (const controller of controllers.filter((candidate) => candidate !== AuthController)) {
      expect(apiModule).toMatch(new RegExp(`controllers: \\[[^\\]]*\\b${controller.name}\\b`));
    }
    expect(Reflect.getMetadata('providers', AuthModule)).toContainEqual({ provide: APP_GUARD, useClass: AuthGuard });
  });

  it('leaves only /health and /auth/* open, and no method carries @Public()', () => {
    const openRoutes = controllers.filter(open).flatMap(routes);
    expect(openRoutes.length).toBeGreaterThan(0);
    for (const route of openRoutes) {
      expect(route === 'health' || route.startsWith('auth/')).toBe(true);
    }
    for (const controller of controllers) {
      for (const name of Object.getOwnPropertyNames(controller.prototype).filter((key) => key !== 'constructor')) {
        expect(Reflect.hasMetadata(PUBLIC_KEY, (controller.prototype as Record<string, object>)[name])).toBe(false);
      }
    }
    expect(controllers.filter((controller) => !open(controller)).flatMap(routes)).not.toContain('health');
    expect(controllers).toContain(AuthController);
  });

  it('lists the setup routes with their siblings: first-run routes open, Replace app guarded', () => {
    expect(routes(AuthController)).toEqual(expect.arrayContaining(['auth/github/owner', 'auth/github/install']));
    expect(open(AuthController)).toBe(true);
    expect(routes(ConnectionsController)).toContain('connections/github/app');
    expect(open(ConnectionsController)).toBe(false);
  });

  it('opens no controller under another path', () => {
    const names = controllers.filter(open).map((controller) => controller.name);
    expect(names.sort()).toEqual(['AuthController', 'HealthController']);
  });
});
