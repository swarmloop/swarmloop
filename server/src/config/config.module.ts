import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { SystemClock, Clock } from '../core/clock';
import { codeHostAdapters } from '../integrations/code-host/code-host-adapters';
import { AppConfig, readEnv, type HostEnvKeys } from './env';
import { DefaultsLayout } from './defaults-layout';
import { envSchema } from './env.schema';
import { applySettings, envFilePath, readSettings } from './load-env';
import { resolveRepoRoot } from './repo-root';
import { SettingSources } from './setting-sources';

@Module({})
export class SwarmloopConfigModule {
  static forRoot(envFile?: string, launchEnv?: Readonly<NodeJS.ProcessEnv>): DynamicModule {
    const path = envFile ?? envFilePath(resolveRepoRoot(undefined, __dirname), launchEnv);
    const settings = readSettings(path, launchEnv);
    const result = envSchema.validate(settings.values, {
      abortEarly: false,
      allowUnknown: true,
      convert: true,
    });
    if (result.error) throw result.error;
    const value = result.value as Record<string, unknown>;
    if (launchEnv === undefined) applySettings(settings);
    return {
      global: true,
      module: SwarmloopConfigModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          ignoreEnvVars: true,
          skipProcessEnv: true,
          load: [() => value],
        }),
      ],
      providers: [
        { provide: SettingSources, useValue: new SettingSources(settings.sources) },
        { provide: DefaultsLayout, useValue: DefaultsLayout.fromDefaultsFile() },
        {
          provide: AppConfig,
          useFactory: (config: ConfigService) => new AppConfig(readEnv(config, hostEnvKeys())),
          inject: [ConfigService],
        },
        { provide: Clock, useClass: SystemClock },
      ],
      exports: [AppConfig, Clock, SettingSources, DefaultsLayout],
    };
  }
}

/** The keys of the code hosts: base urls and tokens in the order the hosts build a push url, then the login apps by name. */
function hostEnvKeys(): HostEnvKeys {
  return {
    server: [...codeHostAdapters()]
      .sort((a, b) => a.pushOrder - b.pushOrder)
      .flatMap((adapter) => [adapter.baseKey, adapter.tokenKey]),
    login: codeHostAdapters().flatMap(({ clientEnvKeys }) => [clientEnvKeys.clientId, clientEnvKeys.clientSecret]),
  };
}
