import { BadRequestException } from '@nestjs/common';
import type { Subtask } from '../contract/subtask';
import type { DocumentRepository } from '../history/document.repository';
import type { RunEntity } from '../history/entities';
import { summaryForBranch } from '../git/naming/git-names';
import { storedBranch } from '../git/naming/stored-branch';
import { requirementsBrief } from '../steps/shared/requirements-brief';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { keepFor, renderKeep } from '../steps/shared/keep-lines';

/** The prompt of a subtask: its task, the parent's requirements as context, and the branch it starts from. */
function subtaskPrompt(task: Subtask, kept: string, brief: string, branch: string): string {
  return [
    `${task.title}\n\n${task.description}`,
    `files: ${task.files.join(', ')}`,
    `proof: ${task.proof}`,
    ...(kept ? [kept] : []),
    `Requirements of the parent run, for context:\n${brief.trimEnd()}`,
    `branch: ${branch}`,
  ].join('\n\n');
}

/** The kept capabilities of the parent's split that name `task`, as a constraint on its checks, reviewers and proof. */
function keptBlock(body: string | null, task: Subtask): string {
  const lines = keepFor(body ? ARTIFACTS.keep.parse(body) : [], task.id);
  if (lines.length === 0) return '';
  return `Kept capabilities (this task's checks, reviewers and proof must keep each one green):\n${renderKeep(lines)}`;
}

/** The prompt of a subtask of a parent run: its task, the parent brief, and the feature branch it starts from. */
export async function subtaskPromptOf(
  documents: DocumentRepository,
  parent: RunEntity,
  task: Subtask,
): Promise<string> {
  const requirements = await documents.latestBody(parent.key, 'requirements');
  if (!requirements?.trim()) {
    throw new BadRequestException('requirements is missing');
  }
  const stored = await documents.latestBody(parent.key, ARTIFACTS.branchNames.kind);
  const branch = storedBranch(stored, null, parent.key, summaryForBranch(requirements, parent.key));
  const kept = keptBlock(await documents.latestBody(parent.key, ARTIFACTS.keep.kind), task);
  return subtaskPrompt(task, kept, requirementsBrief(requirements), branch);
}
