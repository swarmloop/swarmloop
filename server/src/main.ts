import 'reflect-metadata';
import { CommandFactory } from 'nest-commander';
import { applySettings, assertSettings, readSettings } from './config/load-env';

async function bootstrap(): Promise<void> {
  try {
    const settings = readSettings();
    const envError = assertSettings(settings);
    if (envError) {
      fail(envError);
      return;
    }
    applySettings(settings);
    const { AppModule } = await import('./app.module');
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
