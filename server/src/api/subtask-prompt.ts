import { BadRequestException } from '@nestjs/common';
import type { Subtask } from '../contract/subtask';
import type { DocumentRepository } from '../history/document.repository';
import type { RunEntity } from '../history/entities';
import { branchName, summaryForBranch } from '../steps/branch/branch-name';
import { deriveState } from '../history/run-state';
import { requirementsBrief } from '../steps/shared/requirements-brief';
import { mergeSummaryOf } from '../pipeline/merge-summary';
import { mergedFilesOf } from '../pipeline/merged-files';
import { ARTIFACTS } from '../steps/contract/artifacts';
import { keepFor, renderKeep } from '../steps/shared/keep-lines';
import { renderTaskMap, taskMap, type TaskRuns } from '../steps/shared/task-map';

/** The prompt of a subtask: its task, the parent's requirements as context, and the branch it starts from. */
function subtaskPrompt(task: Subtask, map: string, kept: string, brief: string, branch: string): string {
  return [
    `${task.title}\n\n${task.description}`,
    `files: ${task.files.join(', ')}`,
    `proof: ${task.proof}`,
    ...(map ? [map] : []),
    ...(kept ? [kept] : []),
    `Requirements of the parent run, for context:\n${brief.trimEnd()}`,
    `branch: ${branch}`,
  ].join('\n\n');
}

/** The merge request text and the changed files of each merged task that `task` depends on, by task id. A run with no readable document has none. */
async function dependencyResults(
  documents: DocumentRepository,
  task: Subtask,
  children: RunEntity[],
): Promise<{ summaries: Record<string, string>; changed: Record<string, string[]> }> {
  const summaries: Record<string, string> = {};
  const changed: Record<string, string[]> = {};
  for (const id of task.depends) {
    const child = children.find((item) => item.taskId === id);
    const summary = child ? await mergeSummaryOf(documents, child.key) : '';
    if (summary) summaries[id] = summary;
    const files = child ? await mergedFilesOf(documents, child.key) : [];
    if (files.length > 0) changed[id] = files;
  }
  return { summaries, changed };
}

/** The kept capabilities of the parent's split that name `task`, as a constraint on its checks, reviewers and proof. */
function keptBlock(body: string | null, task: Subtask): string {
  const lines = keepFor(body ? ARTIFACTS.keep.parse(body) : [], task.id);
  if (lines.length === 0) return '';
  return `Kept capabilities (this task's checks, reviewers and proof must keep each one green):\n${renderKeep(lines)}`;
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
  const { summaries, changed } = await dependencyResults(documents, task, children);
  const map = renderTaskMap(taskMap(tasks, task, runs, summaries, changed));
  const kept = keptBlock(await documents.latestBody(parent.key, ARTIFACTS.keep.kind), task);
  return subtaskPrompt(task, map, kept, requirementsBrief(requirements), branch);
}
