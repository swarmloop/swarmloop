import type { RebaseHosts } from '../git/rebase/types';
import { RebasedPublisher } from '../steps/shared/rebased-publisher';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { ConflictException, Injectable } from '@nestjs/common';
import { AppConfig } from '../config/env';
import { ERROR_CODES, type ErrorCode } from '../contract/error-codes';
import { SwarmloopError } from '../core/swarmloop-error';
import { git, GIT_LIMITS, gitDetail, gitSync } from '../git/git';
import { ignoredDirectories } from '../git/ignored-entries';
import { fetchBranch, parseJournal, REBASE_JOURNAL, unfinished } from '../git/rebase';
import { repoNames } from '../git/repo-names';
import { DocumentRepository } from '../history/document.repository';
import { EventRepository } from '../history/event.repository';
import type { RunEntity } from '../history/entities';
import { root } from '../history/run-paths';
import { RunRepository } from '../history/run.repository';
import { assertRepoAllowed, resolveCheckoutPath } from '../config/checkout-path';
import { originProject, parsePipelineRefs } from '../steps/pipeline/pipeline-report';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { BranchCheckout } from '../steps/shared/branch-checkout';
import { CheckoutService, leftoverOnly } from '../steps/shared/checkout.service';

/**
 * The kind of the documents that hold the environment record of a repo, with its setup result. It repeats
 * `ENVIRONMENT` of `environment/project-environments.ts`, which the module boundaries do not let `pipeline/` import.
 */
const ENVIRONMENT = 'environment';

/** The codes that block a run until a person has fixed the cause. The reconciler and the driver never retry them. */
const BLOCKING: readonly ErrorCode[] = [
  ERROR_CODES.DISK_LOW,
  ERROR_CODES.WORKSPACE_LOST,
  ERROR_CODES.BRANCH_IN_USE,
  ERROR_CODES.BRANCH_DIVERGED,
  ERROR_CODES.REBASE_CONFLICT,
];

/** The error when it is one of the blocking codes of a workspace or disk check, else null. */
export function workspaceBlock(error: unknown): SwarmloopError | null {
  return error instanceof SwarmloopError && BLOCKING.includes(error.code) ? error : null;
}

interface Checkout {
  name: string;
  path: string;
}

/** What a worktree is created from: an existing branch, or a new branch at a ref. */
interface Base {
  ref: string;
  create: boolean;
  /** Commits of the local branch that the published commit lacks. */
  adopted: number;
}

/**
 * Brings the worktrees of a run back before anything mounts them: a worktree that retention removed is added again
 * on the run's branch, one whose registration the host pruned is added fresh with its files copied back. A run
 * whose worktrees are in place costs no git call.
 */
@Injectable()
export class WorkspaceGuard {
  constructor(
    private readonly checkouts: CheckoutService,
    private readonly branches: BranchCheckout,
    private readonly runs: RunRepository,
    private readonly documents: DocumentRepository,
    private readonly events: EventRepository,
    private readonly config: AppConfig,
    private readonly publisher: RebasedPublisher,
  ) {}

  async ensure(run: RunEntity): Promise<void> {
    const base = root(this.config);
    const removed = run.workspace === 'removed';
    if (run.targetPath || (!removed && !existsSync(join(base, 'worktrees', run.key)))) {
      return;
    }
    const body = await this.documents.latestBody(run.key, ARTIFACTS.repos.kind);
    if (!body?.trim()) {
      return;
    }
    const hosts = await this.publisher.hostsFor(run);
    for (const name of validNames(body)) {
      await this.ensureRepo(run, name, removed, hosts);
    }
    if (removed) {
      await this.runs.clearWorkspaceRemoved(run.key);
    }
  }

  /** The same check for a request of a person: a run that cannot go on is refused with a conflict that says why. */
  async ensureForRequest(run: RunEntity): Promise<void> {
    try {
      await this.ensure(run);
    } catch (error) {
      const block = workspaceBlock(error);
      throw block ? new ConflictException(block.message) : error;
    }
  }

  private async ensureRepo(run: RunEntity, name: string, removed: boolean, hosts: RebaseHosts): Promise<void> {
    const worktree = join(root(this.config), 'worktrees', run.key, name);
    const present = existsSync(worktree);
    if (present && registrationPresent(worktree)) {
      return;
    }
    let checkout: Checkout;
    try {
      assertRepoAllowed(this.config.env.SWARMLOOP_REPOS, name);
      checkout = { name, path: resolveCheckoutPath(root(this.config), this.config.env.CHECKOUTS_ROOT, name, '') };
      this.checkouts.assertCheckout(checkout);
    } catch (error) {
      // A repo that was never prepared has no checkout to add a worktree from: its step reports that.
      if (removed || present) {
        throw error;
      }
      return;
    }
    if (present && (await this.checkouts.registered(checkout, worktree))) {
      return;
    }
    await this.checkouts.assertGit(checkout);
    await this.assertNoOpenRebase(run, name);
    const branch = this.branches.branchFor(run.key, await this.documents.latestBody(run.key, 'requirements'));
    const refs = parsePipelineRefs((await this.documents.latestBody(run.key, ARTIFACTS.pipelineRef.kind)) ?? '');
    const project = await originProject(checkout.path);
    const sha = refs.find((ref) => ref.project === project)?.sha || null;
    const base = await this.baseOf(checkout, branch, sha, hosts);
    if (!base) {
      if (removed) {
        throw new SwarmloopError(
          `${name} workspace is lost: no branch ${branch}, no origin/${branch} and no commit left`,
          {
            code: ERROR_CODES.WORKSPACE_LOST,
          },
        );
      }
      return;
    }
    if (present && !leftoverOnly(worktree)) {
      await this.restoreFiles(run, checkout, worktree, branch, base);
    } else {
      rmSync(worktree, { recursive: true, force: true });
      await this.add(run, checkout, worktree, branch, base);
    }
    if (base.adopted > 0) {
      await this.events.recordLoop(run, 'adopted', base.adopted, `adopted ${base.adopted} commits`);
      await this.runs.bumpGeneration(run.key);
    }
    await this.markSetupStale(run, name);
  }

  /** The first source that exists: the local branch, `origin/<branch>` after a fetch, the published SHA. */
  private async baseOf(
    checkout: Checkout,
    branch: string,
    sha: string | null,
    hosts: RebaseHosts,
  ): Promise<Base | null> {
    const remote = await this.fetched(checkout, branch, hosts);
    if (await has(checkout.path, `refs/heads/${branch}`)) {
      await this.assertFree(checkout, branch);
      await this.assertNotDiverged(checkout, branch, remote, sha);
      return { ref: branch, create: false, adopted: await this.unpublished(checkout, branch, sha) };
    }
    if (remote) {
      return { ref: `origin/${branch}`, create: true, adopted: 0 };
    }
    if (sha && (await has(checkout.path, `${sha}^{commit}`))) {
      return { ref: sha, create: true, adopted: 0 };
    }
    return null;
  }

  /** True when origin has the branch. A fetch that fails counts as a branch that is gone. */
  private async fetched(checkout: Checkout, branch: string, hosts: RebaseHosts): Promise<boolean> {
    try {
      return await fetchBranch(checkout.path, checkout.name, branch, hosts);
    } catch {
      return false;
    }
  }

  /** The branch may not be checked out in a person's checkout or worktree. Swarmloop's own worktrees do not count. */
  private async assertFree(checkout: Checkout, branch: string): Promise<void> {
    const own = join(root(this.config), 'worktrees') + sep;
    const listed = await git(['-C', checkout.path, 'worktree', 'list', '--porcelain'], undefined, {
      timeoutMs: GIT_LIMITS.worktree,
    });
    for (const block of listed.split('\n\n')) {
      const lines = block.split('\n');
      const path = lines.find((line) => line.startsWith('worktree '))?.slice('worktree '.length);
      if (path && !path.startsWith(own) && lines.includes(`branch refs/heads/${branch}`)) {
        throw new SwarmloopError(
          `${checkout.name} branch ${branch} is checked out in ${path}. Switch that checkout to another branch and Resume, or let swarmloop continue on a copy: swarmloop/${branch}, pushed to ${branch} on the same remote with lease.`,
          { code: ERROR_CODES.BRANCH_IN_USE },
        );
      }
    }
  }

  /** Local and remote both moved off the published commit and neither holds the other: only a person can join them. */
  private async assertNotDiverged(
    checkout: Checkout,
    branch: string,
    remote: boolean,
    sha: string | null,
  ): Promise<void> {
    if (!remote) {
      return;
    }
    const local = await git(['-C', checkout.path, 'rev-parse', `refs/heads/${branch}`], undefined, {
      timeoutMs: GIT_LIMITS.query,
    });
    const origin = await git(['-C', checkout.path, 'rev-parse', `refs/remotes/origin/${branch}`], undefined, {
      timeoutMs: GIT_LIMITS.query,
    });
    const moved = sha === null || (local !== sha && origin !== sha);
    if (
      moved &&
      !(await isAncestor(checkout.path, local, origin)) &&
      !(await isAncestor(checkout.path, origin, local))
    ) {
      throw new SwarmloopError(
        `${checkout.name} branch ${branch} diverged: local ${local.slice(0, 8)} and origin ${origin.slice(0, 8)} each have commits the other lacks. Nothing was pushed. Join them in your checkout, then Resume.`,
        { code: ERROR_CODES.BRANCH_DIVERGED },
      );
    }
  }

  /** Commits on the local branch that the published commit lacks: the run continues from that tip. */
  private async unpublished(checkout: Checkout, branch: string, sha: string | null): Promise<number> {
    if (!sha || !(await has(checkout.path, `${sha}^{commit}`))) {
      return 0;
    }
    return Number(
      await git(['-C', checkout.path, 'rev-list', '--count', `${sha}..refs/heads/${branch}`], undefined, {
        timeoutMs: GIT_LIMITS.query,
      }),
    );
  }

  /** A worktree that is recreated does not carry a rebase on: the run is blocked as for a changed fingerprint. */
  private async assertNoOpenRebase(run: RunEntity, name: string): Promise<void> {
    const journal = parseJournal(await this.documents.latestBody(run.key, REBASE_JOURNAL));
    const entry = journal[name];
    if (unfinished(journal) && entry && entry.checkpoint !== 'completed' && entry.generation === run.generation) {
      throw new SwarmloopError(`${name} rebase blocked: the worktree was recreated before the rebase completed`, {
        code: ERROR_CODES.REBASE_CONFLICT,
      });
    }
  }

  private async add(run: RunEntity, checkout: Checkout, worktree: string, branch: string, base: Base): Promise<void> {
    mkdirSync(join(root(this.config), 'worktrees', run.key), { recursive: true });
    if (!existsSync(worktree) && (await this.listsPath(checkout, worktree))) {
      await this.checkouts.forgetWorktree(checkout, worktree);
    }
    await this.checkouts.addWorktree(run.key, checkout, worktree, base.ref, { name: branch, create: base.create });
  }

  private async listsPath(checkout: Checkout, worktree: string): Promise<boolean> {
    const listed = await git(['-C', checkout.path, 'worktree', 'list', '--porcelain'], undefined, {
      timeoutMs: GIT_LIMITS.worktree,
    });
    return listed.split('\n').includes(`worktree ${worktree}`);
  }

  /** The registration is gone but the files are there: they move aside, a fresh worktree is added and they go back. */
  private async restoreFiles(
    run: RunEntity,
    checkout: Checkout,
    worktree: string,
    branch: string,
    base: Base,
  ): Promise<void> {
    const aside = join(root(this.config), 'worktrees', run.key, `.${checkout.name}.moved`);
    rmSync(aside, { recursive: true, force: true });
    renameSync(worktree, aside);
    await this.add(run, checkout, worktree, branch, base);
    // The `.git` file in `aside` points to a registration that is gone, so git reads the fresh worktree's git dir.
    const gitDir = gitSync(['-C', worktree, 'rev-parse', '--absolute-git-dir']).trim();
    const ignored = ignoredDirectories(aside, gitDir);
    for (const entry of readdirSync(aside)) {
      if (entry !== '.git') {
        cpSync(join(aside, entry), join(worktree, entry), {
          recursive: true,
          force: true,
          filter: (src) => !ignored.has(relative(aside, src)),
        });
      }
    }
    try {
      await git(['-C', worktree, 'status', '--porcelain'], undefined, { timeoutMs: GIT_LIMITS.status });
    } catch (error) {
      throw new SwarmloopError(`${checkout.name} worktree failed: ${gitDetail(error)}`);
    }
    rmSync(aside, { recursive: true, force: true });
  }

  /** Drops the recorded setup run of a repo, so the next step runs the setup in the new worktree. */
  private async markSetupStale(run: RunEntity, repo: string): Promise<void> {
    for (const kind of [`${ENVIRONMENT}:${repo}`, ENVIRONMENT]) {
      const body = await this.documents.latestBody(run.key, kind);
      if (!body || body === 'null') {
        continue;
      }
      const record = JSON.parse(body) as { repo?: string; setup?: unknown };
      if (record.repo === repo && record.setup) {
        delete record.setup;
        await this.documents.putDocument(run, kind, JSON.stringify(record));
      }
    }
  }
}

/** The repo names of a `repos` document. A body that names none is left to the step, which reports it. */
function validNames(body: string): string[] {
  try {
    return repoNames(body);
  } catch {
    return [];
  }
}

/** Whether a worktree is intact: its `.git` is a repo of its own, or points at a registration that exists. No git call. */
function registrationPresent(worktree: string): boolean {
  try {
    if (statSync(join(worktree, '.git')).isDirectory()) {
      return true;
    }
    const text = readFileSync(join(worktree, '.git'), 'utf8');
    return text.startsWith('gitdir: ') && existsSync(text.slice('gitdir: '.length).trim());
  } catch (error) {
    // A directory without a `.git` was never a worktree of swarmloop: there is nothing to restore it from.
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

async function has(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(['-C', cwd, 'cat-file', '-e', ref], undefined, { timeoutMs: GIT_LIMITS.query, answers: [1, 128] });
    return true;
  } catch {
    return false;
  }
}

async function isAncestor(cwd: string, older: string, newer: string): Promise<boolean> {
  try {
    await git(['-C', cwd, 'merge-base', '--is-ancestor', older, newer], undefined, {
      timeoutMs: GIT_LIMITS.query,
      answers: [1],
    });
    return true;
  } catch {
    return false;
  }
}
