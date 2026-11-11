import type { RemoteRepository, RepositoryOwner } from '../../../contract/api';
import type { CreateRepositoryDraft, RepositoryApi } from '../code-host';

interface GithubRepo {
  name?: string;
  owner?: { login?: string };
  private?: boolean;
  visibility?: string;
  default_branch?: string;
  permissions?: { push?: boolean };
}

interface GithubMembership {
  role?: string;
  organization?: { login?: string; members_can_create_repositories?: boolean };
}

function githubListUrl(root: string, page: number, perPage: number): string {
  return `${root}/user/repos?affiliation=owner,collaborator,organization_member&per_page=${perPage}&page=${page}`;
}

/** The repository of one row, or null when the token cannot push to it. */
function githubRepository(row: unknown): RemoteRepository | null {
  const repo = row as GithubRepo | null;
  if (!repo?.name || !repo.owner?.login || repo.permissions?.push === false) {
    return null;
  }
  const visibility = repo.visibility ?? (repo.private ? 'private' : 'public');
  return {
    host: 'github',
    owner: repo.owner.login,
    name: repo.name,
    visibility: visibility === 'public' ? 'public' : 'private',
    defaultBranch: repo.default_branch ?? 'main',
  };
}

/** The account, and the organizations where the user is an owner or the organization lets members create. */
async function githubOwners(root: string, read: (url: string) => Promise<unknown>): Promise<RepositoryOwner[]> {
  const user = (await read(`${root}/user`)) as { login?: string } | null;
  const memberships = (await read(`${root}/user/memberships/orgs?state=active&per_page=100`)) as GithubMembership[];
  const owners: RepositoryOwner[] = user?.login ? [{ host: 'github', login: user.login, kind: 'user' }] : [];
  for (const membership of memberships) {
    const login = membership.organization?.login;
    if (login && (membership.role === 'admin' || membership.organization?.members_can_create_repositories)) {
      owners.push({ host: 'github', login, kind: 'organization' });
    }
  }
  return owners;
}

function githubCreateRequest(root: string, draft: CreateRepositoryDraft): { url: string; payload: string } {
  const path = draft.owner.kind === 'user' ? '/user/repos' : `/orgs/${encodeURIComponent(draft.owner.login)}/repos`;
  return {
    url: `${root}${path}`,
    payload: JSON.stringify({ name: draft.name, private: !draft.isPublic, auto_init: true }),
  };
}

export const githubRepositories: RepositoryApi = {
  gitUser: 'x-access-token',
  needs: 'repo scope (public_repo for public repositories only)',
  listUrl: githubListUrl,
  repositoryOf: githubRepository,
  readOwners: githubOwners,
  createRequest: githubCreateRequest,
};
