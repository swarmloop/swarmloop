import { DynamicModule, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { join } from 'path';
import { envSchema } from './env.schema';
import { loadEnvFile } from './load-env';
import { resolveRepoRoot } from './repo-root';

@Module({})
export class SwarmloopConfigModule {
  static forRoot(envFilePath?: string): DynamicModule {
    const path = envFilePath ?? join(resolveRepoRoot(undefined, __dirname), '.env');
    loadEnvFile(path);
    return {
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
    };
  }
}

