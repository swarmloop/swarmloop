import { BadRequestException } from '@nestjs/common';
import { repositoryPick } from '../../config/repository-pick';
import { isHostOutage } from '../../core/swarmloop-error';
import type { RemoteRepositories } from '../../steps/prepare/remote-repositories.service';

/**
 * The repositories of a new backlog with each pick of a remote repository (`owner/name`) cloned and replaced by its checkout folder,
 * by the same path a new run uses. Anything that is not a pick is left for checkRepositories to judge.
 * A host outage passes on as it is; any other failure names the repository and the reason.
 */
export async function clonePicked(remote: RemoteRepositories, actor: string | null, values: unknown): Promise<unknown> {
  if (!Array.isArray(values)) {
    return values;
  }
  const folders: unknown[] = [];
  for (const value of values as unknown[]) {
    folders.push(
      typeof value === 'string' && repositoryPick(value) !== null ? await cloneOne(remote, actor, value) : value,
    );
  }
  return folders;
}

async function cloneOne(remote: RemoteRepositories, actor: string | null, value: string): Promise<string> {
  try {
    return await remote.clone(value, actor);
  } catch (error) {
    if (isHostOutage(error)) {
      throw error;
    }
    throw new BadRequestException(
      `${value} cannot be cloned: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
