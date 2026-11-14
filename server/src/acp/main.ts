import { join, resolve } from 'path';
import { applySettings, envFilePath, readSettings } from '../config/load-env';
import { rawEnv } from '../config/process-env';
import { machineToken } from '../auth/machine-token';
import { SystemClock } from '../core/clock';
import { Sloop, serve } from './agent';
import { HttpServerApi } from './server-api';
import { runShell } from './shell';
import { readApiUrl } from './shell-env';
import { loadSkills, readCheckoutsRoot } from './skills';

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
    const agent = new Sloop({
      api: new HttpServerApi(readApiUrl(envFilePath(root)), machineToken(root, rawEnv().SWARMLOOP_TOKEN)),
      skills: loadSkills(join(root, 'skills')),
      repoRoot: root,
      checkoutsRoot: readCheckoutsRoot(envFilePath(root)),
      clock: new SystemClock(),
    });
    await serve(process.stdin, process.stdout, agent);
    return;
  }
  await runShell(process.argv.slice(2));
}

void main();
