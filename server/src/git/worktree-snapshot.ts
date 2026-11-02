import { execFile } from 'child_process';
import { randomBytes } from 'crypto';
import { realpathSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { RunEntity } from '../history/entities';
import { HistoryService } from '../history/history.service';
import { mountsForRun } from '../sandbox/sandbox-launch';

export const SNAPSHOT = 'snapshot';
export const SHELL_RESUME = 'shell_resume';

export interface RepoTree {
  repo: string;
  head: string;
  tree: string;
}

export interface SnapshotBody {
  step: string;
  at: string;
  chat: string;
  repos: RepoTree[];
}

function git(repo: string, args: string[], extra?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', repo, ...args], { env: { ...process.env, ...extra } }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error((stderr || error.message).trim()));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function isGitRepo(repo: string): Promise<boolean> {
  try {
    return (await git(repo, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true';
  } catch {
    return false;
  }
}

async function ownsRepo(repo: string): Promise<boolean> {
  if (!(await isGitRepo(repo))) {
    return false;
  }
  try {
    const top = (await git(repo, ['rev-parse', '--show-toplevel'])).trim();
    return realpathSync(top) === realpathSync(repo);
  } catch {
    return false;
  }
}

/** Index and HEAD stay put. The tree includes untracked files and skips ignored ones. A subdirectory of a repository is not rewound. */
export async function captureTree(repo: string): Promise<{ head: string; tree: string } | null> {
  if (!(await ownsRepo(repo))) {
    return null;
  }
  let head = '';
  try {
    head = (await git(repo, ['rev-parse', 'HEAD'])).trim();
  } catch {
    head = '';
  }
  const index = join(tmpdir(), `swarmloop-index-${randomBytes(8).toString('hex')}`);
  try {
    const env = { GIT_INDEX_FILE: index };
    await git(repo, ['add', '-A'], env);
    const tree = (await git(repo, ['write-tree'], env)).trim();
    return { head, tree };
  } finally {
    rmSync(index, { force: true });
    rmSync(`${index}.lock`, { force: true });
  }
}

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

export async function snapshotRun(history: HistoryService, run: RunEntity, step: string, chat?: string): Promise<void> {
  try {
    const mounts = mountsForRun(join(history.root(), 'worktrees', run.key), run.targetPath);
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
    const recorded = chat !== undefined ? chat : ((await history.latestChatId(run.id)) ?? '');
    await history.putDocument(run, SNAPSHOT, renderSnapshot({ step, at: new Date().toISOString(), chat: recorded, repos }));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'snapshot failed';
    process.stderr.write(`${message}\n`);
  }
}
