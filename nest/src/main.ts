import 'reflect-metadata';
import { CommandFactory } from 'nest-commander';
import { join } from 'path';
import { assertEnvFile } from './config/load-env';
import { resolveRepoRoot } from './config/repo-root';

async function bootstrap(): Promise<void> {
  const envError = assertEnvFile(join(resolveRepoRoot(undefined, __dirname), '.env'));
  if (envError) {
    fail(envError);
    return;
  }
  const { AppModule } = await import('./app.module');
  try {
    await CommandFactory.run(AppModule, {
      logger: ['error', 'warn', 'log'],
      serviceErrorHandler: (error) => {
        fail(error);
      },
    });
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
