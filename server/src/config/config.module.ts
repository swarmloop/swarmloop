import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { join } from 'path';
import { SystemClock, Clock } from '../core/clock';
import { AppConfig, readEnv } from './env';
import { envSchema } from './env.schema';
import { loadEnvFile } from './load-env';
import { resolveRepoRoot } from './repo-root';

@Module({})
export class SwarmloopConfigModule {
  static forRoot(envFilePath?: string): DynamicModule {
    const path = envFilePath ?? join(resolveRepoRoot(undefined, __dirname), '.env');
    loadEnvFile(path);
    return {
      global: true,
      module: SwarmloopConfigModule,
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          validationSchema: envSchema,
          validationOptions: {
            abortEarly: false,
            allowUnknown: true,
            convert: true,
          },
        }),
      ],
      providers: [
        {
          provide: AppConfig,
          useFactory: (config: ConfigService) => new AppConfig(readEnv(config)),
          inject: [ConfigService],
        },
        { provide: Clock, useClass: SystemClock },
      ],
      exports: [AppConfig, Clock],
    };
  }
}
