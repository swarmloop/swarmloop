import { join, resolve } from 'path';
import { Sloop, serve } from './agent';
import { HttpNestApi } from './nest-api';
import { runShell } from './shell';
import { loadSkills, readCheckoutsRoot } from './skills';

async function main(): Promise<void> {
  if (process.argv[2] === 'acp') {
    const root = resolve(__dirname, '../../..');
    const agent = new Sloop({
      api: new HttpNestApi(process.env.SWARMLOOP_API_URL ?? 'http://127.0.0.1:3920'),
      skills: loadSkills(join(root, 'skills')),
      repoRoot: root,
      checkoutsRoot: readCheckoutsRoot(join(root, '.env')),
    });
    await serve(process.stdin, process.stdout, agent);
    return;
  }
  await runShell(process.argv.slice(2));
}

void main();
