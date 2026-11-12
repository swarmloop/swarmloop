import { BadRequestException } from '@nestjs/common';
import type { Subtask } from '../contract/subtask';
import type { DocumentRepository } from '../history/document.repository';
import type { RunEntity } from '../history/entities';
import { branchName, summaryForBranch } from '../steps/branch/branch-name';
import { requirementsBrief } from '../steps/shared/requirements-brief';

/** The prompt of a subtask: its task, the parent's requirements as context, and the branch it starts from. */
function subtaskPrompt(task: Subtask, brief: string, branch: string): string {
  return [
    `${task.title}\n\n${task.description}`,
    `files: ${task.files.join(', ')}`,
    `proof: ${task.proof}`,
    `Requirements of the parent run, for context:\n${brief.trimEnd()}`,
    `branch: ${branch}`,
  ].join('\n\n');
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
  const branch = branchName(parent.key, summaryForBranch(requirements, parent.key));
  return subtaskPrompt(task, requirementsBrief(requirements), branch);
}
