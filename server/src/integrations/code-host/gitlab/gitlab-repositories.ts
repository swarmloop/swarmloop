import type { RemoteRepository, RepositoryOwner } from '../../../contract/api';
import type { RepositoryApi } from '../abstract-code-host';
import type { CreateRepositoryDraft } from '../code-host';

/** Developer: the lowest role that can push. */
const DEVELOPER = 30;

interface GitlabProject {
  path?: string;
  namespace?: { full_path?: string };
  visibility?: string;
  default_branch?: string | null;
}

interface GitlabNamespace {
  id?: number;
  full_path?: string;
  project_creation_level?: string;
}

function gitlabListUrl(root: string, page: number, perPage: number): string {
  return `${root}/api/v4/projects?membership=true&min_access_level=${DEVELOPER}&per_page=${perPage}&page=${page}`;
}

function gitlabRepository(row: unknown): RemoteRepository | null {
  const project = row as GitlabProject | null;
  if (!project?.path || !project.namespace?.full_path) {
    return null;
  }
  return {
    host: 'gitlab',
    owner: project.namespace.full_path,
    name: project.path,
    visibility: project.visibility === 'public' ? 'public' : 'private',
    defaultBranch: project.default_branch ?? 'main',
  };
}

/** The user's namespace, and the groups where the user is a developer or more and projects may be created. */
async function gitlabOwners(root: string, read: (url: string) => Promise<unknown>): Promise<RepositoryOwner[]> {
  const user = (await read(`${root}/api/v4/user`)) as { username?: string; namespace_id?: number } | null;
  const groups = (await read(`${root}/api/v4/groups?min_access_level=${DEVELOPER}&per_page=100`)) as GitlabNamespace[];
  const owners: RepositoryOwner[] = user?.username
    ? [{ host: 'gitlab', login: user.username, kind: 'user', id: user.namespace_id }]
    : [];
  for (const group of groups) {
    if (group.full_path && group.project_creation_level !== 'noone') {
      owners.push({ host: 'gitlab', login: group.full_path, kind: 'group', id: group.id });
    }
  }
  return owners;
}

function gitlabCreateRequest(root: string, draft: CreateRepositoryDraft): { url: string; payload: string } {
  return {
    url: `${root}/api/v4/projects`,
    payload: JSON.stringify({
      name: draft.name,
      path: draft.name,
      visibility: draft.isPublic ? 'public' : 'private',
      initialize_with_readme: true,
      ...(draft.owner.id === undefined ? {} : { namespace_id: draft.owner.id }),
    }),
  };
}

export const gitlabRepositories: RepositoryApi = {
  gitUser: 'oauth2',
  needs: 'api scope and the Developer role',
  listUrl: gitlabListUrl,
  repositoryOf: gitlabRepository,
  readOwners: gitlabOwners,
  createRequest: gitlabCreateRequest,
};
