import { repositoryPick } from '../../config/repository-pick';
import type { StepContext } from '../base-step';
import type { RemoteRepositories } from '../prepare/remote-repositories.service';

/**
 * The checkout folders of a run's projects, in order. A repository picked by owner and name, or a name with no folder yet,
 * is cloned as an activity of the attempt and replaced by the folder it was placed in; any other name is a folder already.
 */
export async function placeProjects(
  ctx: StepContext,
  remote: RemoteRepositories,
  projects: string[],
  actor: string | null,
): Promise<string[]> {
  const folders: string[] = [];
  for (const value of projects) {
    if (repositoryPick(value) === null && remote.hasFolder(value)) {
      folders.push(value);
      continue;
    }
    folders.push(
      await ctx.activity(
        `Clone ${value}`,
        () => remote.clone(value, actor),
        () => 'cloned',
      ),
    );
  }
  return folders;
}
