import { SwarmloopError } from '../../core/swarmloop-error';

export interface RemoteProject {
  host: string;
  project: string;
}

export function remoteProject(url: string): RemoteProject {
  const value = url.trim();
  if (value.includes('://')) {
    const parsed = new URL(value);
    return { host: parsed.hostname, project: projectPath(parsed.pathname) };
  }
  const match = /^[^@]*@([^:]+):(.+)$/.exec(value);
  if (!match?.[1] || !match[2]) {
    throw new SwarmloopError('origin is missing');
  }
  return { host: match[1], project: projectPath(match[2]) };
}

function projectPath(path: string): string {
  const project = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '');
  if (!project || project.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new SwarmloopError('origin is missing');
  }
  return project;
}
