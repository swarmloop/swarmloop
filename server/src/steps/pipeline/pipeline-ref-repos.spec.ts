import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { pipelineRefRepos } from './pipeline-ref-repos';

function repo(root: string, name: string, origin: string): { hostPath: string; containerPath: string; mode: 'rw' } {
  const hostPath = join(root, name);
  mkdirSync(hostPath);
  execFileSync('git', ['-C', hostPath, 'init', '-q']);
  execFileSync('git', ['-C', hostPath, 'remote', 'add', 'origin', origin]);
  return { hostPath, containerPath: `/work/${name}`, mode: 'rw' };
}

describe('pipelineRefRepos', () => {
  it('names the repos whose project the pipeline reference holds', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-ref-repos-'));
    const mounts = [
      repo(root, 'billing-api', 'https://gitlab.example/group/billing-api.git'),
      repo(root, 'billing-web', 'https://gitlab.example/group/billing-web.git'),
    ];
    const ref = 'project: group/billing-api\nref: feature/x\nsha: abc\n';
    expect(await pipelineRefRepos(ref, mounts)).toEqual(['billing-api']);
  });

  it('names nothing without a pipeline reference', async () => {
    const root = mkdtempSync(join(tmpdir(), 'swarmloop-ref-repos-'));
    const mounts = [repo(root, 'billing-api', 'https://gitlab.example/group/billing-api.git')];
    expect(await pipelineRefRepos(null, mounts)).toEqual([]);
  });
});
