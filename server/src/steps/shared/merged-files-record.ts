import { Injectable, Logger } from '@nestjs/common';
import { existsSync } from 'fs';
import { fetchBranch } from '../../git/rebase';
import { git } from '../../git/git';
import { worktreePath } from '../../git/repo-names';
import { withWorktree } from '../../git/worktree-lock';
import { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import { root } from '../../history/run-paths';
import { ARTIFACTS } from '../contract/artifacts';
import { StepKernel } from '../step-kernel';
import { RebasedPublisher } from './rebased-publisher';

/** Stores the files a merge changed as the merged_files document of the run whose requests merged. */
@Injectable()
export class MergedFilesRecord {
  private readonly logger = new Logger(MergedFilesRecord.name);

  constructor(
    private readonly kernel: StepKernel,
    private readonly publisher: RebasedPublisher,
    private readonly documents: DocumentRepository,
  ) {}

  /**
   * Reads the files each merge commit changed from the run's own worktrees, after fetching the target branch of each
   * repository, and stores them. A merge git cannot read stores none and leaves a warning; it never throws.
   */
  async record(
    run: RunEntity,
    merged: Record<string, string>,
    targetBranch: (repo: string) => Promise<string>,
  ): Promise<void> {
    try {
      const files = await this.changedFiles(run, merged, targetBranch);
      await this.documents.putDocument(run, ARTIFACTS.mergedFiles.kind, files.join('\n'));
    } catch (error) {
      this.logger.warn(
        `The files of the merge of ${run.key} were not read: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  /** The files of each merge commit. A path is prefixed with its repository when the task merged into more than one. */
  private async changedFiles(
    run: RunEntity,
    merged: Record<string, string>,
    targetBranch: (repo: string) => Promise<string>,
  ): Promise<string[]> {
    const hosts = await this.publisher.hostsFor(run);
    const repos = Object.entries(merged).filter(([, sha]) => sha);
    const files: string[] = [];
    for (const [repo, sha] of repos) {
      const path = worktreePath(root(this.kernel.config), run.key, repo);
      if (!existsSync(path)) continue;
      const branch = await targetBranch(repo);
      const names = await withWorktree(path, async () =>
        (await fetchBranch(path, repo, branch, hosts))
          ? git(['-C', path, 'diff', '--name-only', `${sha}^`, sha])
          : null,
      );
      if (names === null) continue;
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
