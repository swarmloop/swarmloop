import { existsSync } from 'fs';
import { join } from 'path';
import { Injectable } from '@nestjs/common';
import { GitRuleRefused } from '../../core/git-rule-refused';
import { GitRulesError } from '../../core/swarmloop-error';
import { SWARMLOOP_FILE } from '../../environment/environment-config';
import { gitRefusal } from '../../agent-result/definitions/git-refusal';
import { commitIdentity } from '../../git/git';
import { mountsForStep, worktreePath } from '../../git/repo-names';
import type { RunEntity } from '../../history/entities';
import { root } from '../../history/run-paths';
import { gitAt } from '../commit/commit-git';
import { ARTIFACTS } from '../contract/artifacts';
import { StepKernel } from '../step-kernel';
import { formatRefusal, refusalKey, type RefusalAnswer, type RefusedKind } from './git-refusal-answer';
import { GitRulesWriter } from './git-rules-writer';
import { ImplementChat } from './implement-chat';
import { RebasedPublisher } from './rebased-publisher';
import { RunAuthor } from './run-author';
import { RunNames } from './run-names';

/** What a refusal is about: the run, the repository whose name was refused, and the repositories that share the name. */
interface RefusalScope {
  run: RunEntity;
  repo: string;
  repos: string[];
}

/**
 * Answers a host's refusal of a name once. The first refusal of a kind in a repository asks the implement agent for a new
 * change and the rule behind it, renders the name again and tries once more; a later refusal of that kind is for a person.
 */
@Injectable()
export class GitRefusal {
  constructor(
    private readonly kernel: StepKernel,
    private readonly chat: ImplementChat,
    private readonly names: RunNames,
    private readonly writer: GitRulesWriter,
    private readonly publisher: RebasedPublisher,
    private readonly author: RunAuthor,
  ) {}

  /** Runs `work`. A name already answered once is rendered again first, so a rule put into the repository is used. */
  async guard<T>(scope: RefusalScope, kind: RefusedKind, work: () => Promise<T>): Promise<T> {
    const key = refusalKey(scope.repo, kind);
    const answered = await this.answered(scope.run, key);
    if (answered) {
      await this.render(scope, kind);
    }
    try {
      return await work();
    } catch (error) {
      if (!(error instanceof GitRuleRefused)) {
        throw error;
      }
      if (answered) {
        throw new GitRulesError(error.hostMessage, error.name);
      }
      await this.answer(scope, kind, key, error);
      await this.render(scope, kind);
      return this.again(work);
    }
  }

  private async again<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw error instanceof GitRuleRefused ? new GitRulesError(error.hostMessage, error.name) : error;
    }
  }

  private async answered(run: RunEntity, key: string): Promise<boolean> {
    const bodies = await this.kernel.documents.bodiesOfKind(run.id, ARTIFACTS.gitRefusal.kind);
    return bodies.some((body) => body.startsWith(`${key}\n`));
  }

  /** Asks the agent once with the host's words and the refused name, stores the answer and writes the rule it names. */
  private async answer(scope: RefusalScope, kind: RefusedKind, key: string, refused: GitRuleRefused): Promise<void> {
    const { run } = scope;
    const asked = await this.chat.ask(
      run,
      scope.repos,
      `A code host refused a ${kind === 'commit' ? 'commit message' : kind} of this repository by a rule.\n` +
        `Host message: ${refused.hostMessage}\nRefused ${kind}: ${refused.name}`,
      gitRefusal,
    );
    if ('error' in asked) {
      throw new GitRulesError(refused.hostMessage, refused.name);
    }
    const answer = asked.value as RefusalAnswer;
    await this.kernel.documents.putDocument(run, ARTIFACTS.gitRefusal.kind, formatRefusal(key, answer));
    const mounts = mountsForStep(root(this.kernel.config), run.key, scope.repos, run.targetPath);
    const note = await this.writer.write(mounts, answer.gitRules);
    if (note) {
      const before = await this.kernel.documents.latestBody(run.key, ARTIFACTS.gitRulesNote.kind);
      await this.kernel.documents.putDocument(
        run,
        ARTIFACTS.gitRulesNote.kind,
        before ? `${before.trimEnd()}\n\n${note}\n` : `${note}\n`,
      );
    }
  }

  /** The name again, from the format as it is now and the latest answer. A title is rendered by its caller. */
  private async render(scope: RefusalScope, kind: RefusedKind): Promise<void> {
    if (kind === 'branch') {
      await this.renameBranch(scope);
    } else if (kind === 'commit') {
      await this.amendCommit(scope);
    }
  }

  private async renameBranch({ run, repo, repos }: RefusalScope): Promise<void> {
    const current = await this.names.branch(run, repo);
    const next = await this.names.renderedBranch(run, repo);
    if (next === current) {
      return;
    }
    for (const name of repos) {
      const tree = { repo: name, path: worktreePath(root(this.kernel.config), run.key, name) };
      await gitAt(tree, ['branch', '-m', await this.names.branch(run, name), next], 'branch failed');
    }
    await this.names.rename(run, repo, next);
  }

  /** The head commit, while it is not pushed, takes the message the format gives now and the rule files learned. */
  private async amendCommit({ run, repo }: RefusalScope): Promise<void> {
    const [tree] = this.publisher.trees(run.key, [repo]);
    const branch = await this.names.branch(run, repo);
    const head = await gitAt(tree, ['rev-parse', 'HEAD'], 'branch failed');
    if ((await this.publisher.optionalRev(tree, `refs/remotes/origin/${branch}`)) === head) {
      return;
    }
    if (existsSync(join(tree.path, SWARMLOOP_FILE))) {
      await gitAt(tree, ['add', '--', SWARMLOOP_FILE], 'commit failed');
    }
    const message = await this.names.commitMessage(run, repo);
    const same = (await gitAt(tree, ['log', '-1', '--format=%B'], 'commit failed')).trim() === message.trim();
    const staged = (await gitAt(tree, ['diff', '--cached', '--name-only'], 'commit failed')).trim() !== '';
    if (same && !staged) {
      return;
    }
    const identity = await commitIdentity(tree.path, await this.author.of(run));
    await gitAt(
      tree,
      [...identity.args, 'commit', '--amend', '--no-verify', '-m', message],
      'commit failed',
      identity.env,
    );
  }
}
