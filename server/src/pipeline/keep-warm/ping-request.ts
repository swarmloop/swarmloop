import { join } from 'node:path';
import { isEffort } from '../../contract/effort';
import type { AppConfig } from '../../config/env';
import type { DocumentRepository } from '../../history/document.repository';
import { root } from '../../history/run-paths';
import { mountsForStep, repoNames } from '../../git/repo-names';
import { ARTIFACTS } from '../../steps/contract/artifacts';
import type { AgentLaunchRequest } from '../../steps/shared/agent-launch-request';
import type { DuePing } from './ping-candidates';

/** The words a ping sends: the cache is read by the chat as it stands, and nothing else is asked. */
const PING_PROMPT = 'Reply with one word: ok. Do not use any tool.';

/** The longest a ping may run before it is stopped. It is one reply. */
const PING_TIME_LIMIT_MS = 5 * 60_000;

/**
 * The launch of a ping: the chat's own runtime, model and effort, so the cached prefix matches, and the mounts a visit
 * of the run has, so the chat finds its folder. The owner is a copy of the run's launch facts, so no live run changes.
 * Null when the run has no worktrees to mount.
 */
export async function pingRequest(
  deps: { config: AppConfig; documents: DocumentRepository },
  due: DuePing,
): Promise<AgentLaunchRequest | null> {
  const { run, last } = due;
  const repos = await deps.documents.latestBody(run.key, ARTIFACTS.repos.kind);
  if (!repos?.trim()) return null;
  const dir = root(deps.config);
  return {
    root: dir,
    run: { id: run.id, agentCalls: 0, spentUsd: 0, activeAttempt: null, startedBy: run.startedBy },
    key: run.key,
    step: last.step ?? 'ping',
    mode: 'ask',
    tools: 'none',
    runtime: last.runtime as AgentLaunchRequest['runtime'],
    model: last.model,
    ...(last.effort && isEffort(last.effort) ? { effort: last.effort } : {}),
    timeLimitMs: PING_TIME_LIMIT_MS,
    prompt: PING_PROMPT,
    workspace: join(dir, 'worktrees', run.key),
    mounts: mountsForStep(dir, run.key, repoNames(repos), run.targetPath),
  };
}
