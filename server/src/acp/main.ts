import { join, resolve } from 'path';
import { applySettings, envFilePath, readSettings } from '../config/load-env';
import { SystemClock } from '../core/clock';
import { Sloop, serve } from './agent';
import { NOT_SIGNED_IN, tokenSource } from './cli-token';
import { HttpServerApi } from './server-api';
import { runShell } from './shell';
import { readApiUrl } from './shell-env';
import { loadSkills } from './skills';

async function main(): Promise<void> {
  try {
    applySettings(readSettings());
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'sloop failed'}\n`);
    process.exitCode = 1;
    return;
  }
  if (process.argv[2] === 'acp') {
    const root = resolve(__dirname, '../../..');
    const token = tokenSource();
    if (!token) {
      process.stderr.write(`${NOT_SIGNED_IN}\n`);
      process.exitCode = 1;
      return;
    }
    const agent = new Sloop({
      api: new HttpServerApi(readApiUrl(envFilePath(root)), token),
      skills: loadSkills(join(root, 'skills')),
      repoRoot: root,
      clock: new SystemClock(),
    });
    await serve(process.stdin, process.stdout, agent);
    return;
  }
  await runShell(process.argv.slice(2));
}

void main();
