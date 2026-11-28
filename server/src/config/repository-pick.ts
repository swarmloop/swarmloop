import { isProjectName } from './checkout-path';

const OWNER_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A remote repository picked by owner and name: the owner is the whole namespace path, as the picker shows it. */
interface RepositoryPick {
  owner: string;
  name: string;
}

/** The owner and name of a value such as `acme/team/app`, or null for a bare name or anything that is not one. */
export function repositoryPick(value: string): RepositoryPick | null {
  const cut = value.lastIndexOf('/');
  if (cut <= 0) {
    return null;
  }
  const owner = value.slice(0, cut);
  const name = value.slice(cut + 1);
  if (!owner.split('/').every((segment) => OWNER_SEGMENT.test(segment)) || !isProjectName(name)) {
    return null;
  }
  return { owner, name };
}

/** The checkout folder of a repository whose bare name another repository already holds. */
export function fallbackFolder(owner: string, name: string): string {
  return `${name}-${owner.replaceAll('/', '-')}`;
}
