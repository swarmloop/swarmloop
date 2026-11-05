import { join } from 'path';
import { Logger } from '@nestjs/common';
import type { RunEntity } from '../history/entities';
import type { DocumentRepository } from '../history/document.repository';
import type { VisitRepository } from '../history/visit.repository';
import type { Clock } from '../core/clock';
import { mountsForRun } from '../sandbox/sandbox-launch';

const logger = new Logger('WorktreeSnapshot');

export const SNAPSHOT = 'snapshot';
export const SHELL_RESUME = 'shell_resume';

interface RepoTree {
  repo: string;
  head: string;
  tree: string;
}

interface SnapshotBody {
  step: string;
  at: string;
  chat: string;
  repos: RepoTree[];
}

export { captureTree } from '../git/worktree-tree';
import { captureTree, git, ownsRepo } from '../git/worktree-tree';

/** Local branch goes back to the snapshot commit, then the dirty tree is laid on top. Ignored files stay. */
export async function restoreTree(repo: string, head: string, tree: string): Promise<void> {
  if (!(await ownsRepo(repo))) {
    throw new Error('snapshot is not the repository root');
  }
  if (head) {
    await git(repo, ['reset', '--hard', head]);
  }
  let committed = '';
  if (head) {
    committed = (await git(repo, ['rev-parse', `${head}^{tree}`])).trim();
  }
  if (tree && tree !== committed) {
    await git(repo, ['read-tree', tree]);
    await git(repo, ['checkout-index', '-a', '-f']);
  }
  await git(repo, ['clean', '-fd']);
}

export function renderSnapshot(body: SnapshotBody): string {
  const lines = [`step: ${body.step}`, `at: ${body.at}`];
  if (body.chat) {
    lines.push(`chat: ${body.chat}`);
  }
  lines.push('');
  for (const repo of body.repos) {
    lines.push(`repo: ${repo.repo}`, `head: ${repo.head}`, `tree: ${repo.tree}`, '');
  }
  return `${lines.join('\n')}\n`;
}

export function parseSnapshot(body: string): SnapshotBody {
  const parsed: SnapshotBody = { step: '', at: '', chat: '', repos: [] };
  let repo = '';
  let head = '';
  let tree = '';
  const flush = (): void => {
    if (repo && tree) {
      parsed.repos.push({ repo, head, tree });
    }
    repo = '';
    head = '';
    tree = '';
  };
  for (const line of body.split('\n')) {
    if (line.startsWith('step:')) {
      parsed.step = line.slice('step:'.length).trim();
    } else if (line.startsWith('at:')) {
      parsed.at = line.slice('at:'.length).trim();
    } else if (line.startsWith('chat:')) {
      parsed.chat = line.slice('chat:'.length).trim();
    } else if (line.startsWith('repo:')) {
      flush();
      repo = line.slice('repo:'.length).trim();
    } else if (line.startsWith('head:')) {
      head = line.slice('head:'.length).trim();
    } else if (line.startsWith('tree:')) {
      tree = line.slice('tree:'.length).trim();
    }
  }
  flush();
  return parsed;
}

export function parseResume(body: string | null): { step: string; chat: string } | null {
  if (!body) {
    return null;
  }
  let step = '';
  let chat = '';
  for (const line of body.split('\n')) {
    if (line.startsWith('step:')) {
      step = line.slice('step:'.length).trim();
    } else if (line.startsWith('chat:')) {
      chat = line.slice('chat:'.length).trim();
    }
  }
  if (!step || !chat) {
    return null;
  }
  return { step, chat };
}

interface SnapshotDeps {
  documents: DocumentRepository;
  visits: VisitRepository;
  root: string;
}

export async function snapshotRun(
  deps: SnapshotDeps,
  clock: Clock,
  run: RunEntity,
  step: string,
  chat?: string,
): Promise<void> {
  try {
    const mounts = mountsForRun(join(deps.root, 'worktrees', run.key), run.targetPath);
    const repos: RepoTree[] = [];
    for (const mount of mounts) {
      const captured = await captureTree(mount.hostPath);
      if (captured) {
        repos.push({ repo: mount.hostPath, head: captured.head, tree: captured.tree });
      }
    }
    if (repos.length === 0) {
      return;
    }
    const recorded = chat !== undefined ? chat : ((await deps.visits.latestChatId(run.id)) ?? '');
    await deps.documents.putDocument(run, SNAPSHOT, renderSnapshot({ step, at: clock.iso(), chat: recorded, repos }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'snapshot failed';
    logger.error(message);
  }
}
