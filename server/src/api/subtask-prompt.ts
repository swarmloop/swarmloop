import { BadRequestException } from '@nestjs/common';
import type { Subtask } from '../contract/subtask';
import type { DocumentRepository } from '../history/document.repository';
import type { RunEntity } from '../history/entities';
import { branchName, summaryForBranch } from '../steps/branch/branch-name';
import { deriveState } from '../history/run-state';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { parseMergeRequestSummaries } from '../steps/merge-request/merge-request-record';
import { requirementsBrief } from '../steps/shared/requirements-brief';
import { renderTaskMap, taskMap, type TaskRuns } from '../steps/shared/task-map';

/** The prompt of a subtask: its task, the parent's requirements as context, and the branch it starts from. */
function subtaskPrompt(task: Subtask, map: string, brief: string, branch: string): string {
  return [
    `${task.title}\n\n${task.description}`,
    `files: ${task.files.join(', ')}`,
    `proof: ${task.proof}`,
    ...(map ? [map] : []),
    `Requirements of the parent run, for context:\n${brief.trimEnd()}`,
    `branch: ${branch}`,
  ].join('\n\n');
}

/** The merge request text of each merged task that `task` depends on, by task id. A run with no readable document has none. */
async function dependencySummaries(
  documents: DocumentRepository,
  task: Subtask,
  children: RunEntity[],
): Promise<Record<string, string>> {
  const summaries: Record<string, string> = {};
  for (const id of task.depends) {
    const child = children.find((item) => item.taskId === id);
    const body = child ? await documents.latestBody(child.key, ARTIFACTS.mergeRequest.kind) : null;
    if (!body) continue;
    try {
      summaries[id] = parseMergeRequestSummaries(body).filter(Boolean).join('\n\n');
    } catch {
      continue;
    }
  }
  return summaries;
}

/** The prompt of a subtask of a parent run: its task, the task map, the parent brief, and the feature branch it starts from. */
export async function subtaskPromptOf(
  documents: DocumentRepository,
  parent: RunEntity,
  task: Subtask,
  tasks: Subtask[],
  children: RunEntity[],
): Promise<string> {
  const requirements = await documents.latestBody(parent.key, 'requirements');
  if (!requirements?.trim()) {
    throw new BadRequestException('requirements is missing');
  }
  const branch = branchName(parent.key, summaryForBranch(requirements, parent.key));
  const runs: TaskRuns = {};
  for (const child of children) {
    if (child.taskId) runs[child.taskId] = { state: deriveState(child).state, currentStep: child.currentStep };
  }
  const summaries = await dependencySummaries(documents, task, children);
  const map = renderTaskMap(taskMap(tasks, task, runs, summaries));
  return subtaskPrompt(task, map, requirementsBrief(requirements), branch);
}
