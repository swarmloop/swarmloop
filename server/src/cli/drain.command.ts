import { Command, CommandRunner } from 'nest-commander';
import { AppConfig } from '../config/env';
import type { DrainView } from '../contract/api';
import { delay } from '../core/delay';

const POLL_MS = 1_000;

/** Asks the running server to drain, then waits until it is idle. The drain state lives in the server, not here. */
@Command({ name: 'drain', description: 'Stop taking new runs and steps, and wait until the instance is idle' })
export class DrainCommand extends CommandRunner {
  constructor(private readonly config: AppConfig) {
    super();
  }

  async run(): Promise<void> {
    const { SWARMLOOP_API_HOST: host, SWARMLOOP_API_PORT: port } = this.config.env;
    const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/drain`;
    try {
      let view = await call(url, 'POST');
      process.stdout.write('draining: no new runs or steps are accepted\n');
      while (!view.idle) {
        process.stdout.write(`waiting for ${view.running} running\n`);
        await delay(POLL_MS);
        view = await call(url, 'GET');
      }
      process.stdout.write('idle\n');
    } catch (error) {
      process.stderr.write(`drain failed: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}

async function call(url: string, method: 'GET' | 'POST'): Promise<DrainView> {
  const response = await fetch(url, { method });
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`);
  }
  return (await response.json()) as DrainView;
}
