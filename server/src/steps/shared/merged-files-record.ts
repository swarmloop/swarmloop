import { Injectable, Logger } from '@nestjs/common';
import { existsSync } from 'fs';
import { SwarmloopError } from '../../core/swarmloop-error';
import { git } from '../../git/git';
import { worktreePath } from '../../git/repo-names';
import { withWorktree } from '../../git/worktree-lock';
import { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import { root } from '../../history/run-paths';
import { ARTIFACTS } from '../contract/artifacts';
import { StepKernel } from '../step-kernel';

/** Stores the files a merge put on its target branch as the merged_files document of the run whose requests merged. */
@Injectable()
export class MergedFilesRecord {
  private readonly logger = new Logger(MergedFilesRecord.name);

  constructor(
    private readonly kernel: StepKernel,
    private readonly documents: DocumentRepository,
  ) {}

  /**
   * Stores the run's own change in each repository, from the base tip the run recorded to the head that landed. It is
   * the same for a squash, a rebase and a merge commit, whoever made the merge. A change git cannot read, a run with no
   * recorded base tip or a head nobody reports stores none and leaves a warning; it never throws.
   */
  async record(run: RunEntity, repos: string[], headOf: (repo: string) => Promise<string>): Promise<void> {
    try {
      const files = await this.changedFiles(run, repos, headOf);
      await this.documents.putDocument(run, ARTIFACTS.mergedFiles.kind, files.join('\n'));
    } catch (error) {
      this.logger.warn(
        `The files of the merge of ${run.key} were not read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The files of each repository's change. A path is prefixed with its repository when the task merged into more than one. */
  private async changedFiles(
    run: RunEntity,
    repos: string[],
    headOf: (repo: string) => Promise<string>,
  ): Promise<string[]> {
    const files: string[] = [];
    for (const repo of repos) {
      const path = worktreePath(root(this.kernel.config), run.key, repo);
      if (!existsSync(path)) continue;
      const base = run.baseTips?.[repo];
      if (!base) throw new SwarmloopError(`${run.key} has no recorded base tip in ${repo}`);
      const head = await headOf(repo);
      if (!head) throw new SwarmloopError(`the head that landed in ${repo} for ${run.key} is not known`);
      const names = await withWorktree(path, () => git(['-C', path, 'diff', '--name-only', base, head]));
      files.push(
        ...names
          .split('\n')
          .filter(Boolean)
          .map((name) => (repos.length > 1 ? `${repo}/${name}` : name)),
      );
    }
    return files;
  }
}
