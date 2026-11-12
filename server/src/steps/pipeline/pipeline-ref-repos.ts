import { basename } from 'path';
import type { SandboxMount } from '../../core/sandbox-mount';
import { originProject, parsePipelineRefs } from './pipeline-report';

/** The repos whose origin project the pipeline reference names: the repos whose CI jobs a rerun covers. */
export async function pipelineRefRepos(refBody: string | null, mounts: SandboxMount[]): Promise<string[]> {
  const projects = new Set(parsePipelineRefs(refBody ?? '').map((record) => record.project));
  const repos: string[] = [];
  for (const mount of mounts) {
    const project = await originProject(mount.hostPath);
    if (project && projects.has(project)) {
      repos.push(basename(mount.hostPath));
    }
  }
  return repos;
}
