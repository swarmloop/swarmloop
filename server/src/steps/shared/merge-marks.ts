import type { DocumentRepository } from '../../history/document.repository';
import { parsePaths } from '../../git/commit-paths';
import { ARTIFACTS } from '../contract/artifacts';
import { currentPlan } from './current-plan';
import { handoffText } from './handoff';
import { mergedFilesOf } from './merged-files';

/** The files outside the planned ones. A planned entry names a file or a folder. */
function outsidePlan(planned: string[], merged: string[]): string[] {
  const inside = (file: string) =>
    planned.some((path) => file === path || file.startsWith(`${path.replace(/\/$/, '')}/`));
  return merged.filter((file) => !inside(file));
}

/** The files a plan item names: the list after `files:` up to ` - proof:` or the end of the item. */
function itemFiles(item: string): string[] {
  const start = item.indexOf(' - files: ');
  if (start < 0) return [];
  const rest = item.slice(start + ' - files: '.length);
  const end = rest.indexOf(' - proof:');
  return (end < 0 ? rest : rest.slice(0, end))
    .split(',')
    .map((file) => file.trim())
    .filter(Boolean);
}

const outsideMark = (outside: string[]) =>
  outside.length > 0 ? [`its merge request changed files outside its plan: ${outside.join(', ')}`] : [];

/** What differs from its plan in a merged task, from what the server already has of its run. One reading for every kind of merged task. */
export class MergeMarks {
  constructor(private readonly documents: DocumentRepository) {}

  /** The marks of a merged subtask: the unmet items it covers, its not built lines, its report, and the files outside its plan. */
  async subtaskMarks(runKey: string, task: { covers?: string[]; files: string[] }): Promise<string[]> {
    const covers = task.covers ?? [];
    const unmet = (await this.unmetItems(runKey)).filter((mark) => covers.includes(mark.id));
    const reports = JSON.parse((await this.latest(runKey, ARTIFACTS.starterReport)) || '[]') as {
      decisions: unknown[];
      outOfScope: unknown[];
    }[];
    const merged = await mergedFilesOf(this.documents, runKey);
    const outside = task.files.length > 0 ? outsidePlan(task.files, merged) : [];
    return [
      ...this.unmetMarks(unmet),
      ...(await this.notBuilt(runKey)),
      ...(reports.some((report) => report.decisions.length > 0) ? ['it reported decisions for other tasks'] : []),
      ...(reports.some((report) => report.outOfScope.length > 0) ? ['it left parts out of its scope'] : []),
      ...outsideMark(outside),
    ];
  }

  /** The marks of a merged backlog task: every unmet item of its run, its not built lines, and the files outside its files or its run's plan. */
  async taskMarks(runKey: string, task: { files: string[] }): Promise<string[]> {
    const planned = task.files.length > 0 ? task.files : await this.plannedFiles(runKey);
    const outside = planned.length > 0 ? outsidePlan(planned, await this.changedFiles(runKey)) : [];
    return [
      ...this.unmetMarks(await this.unmetItems(runKey)),
      ...(await this.notBuilt(runKey)),
      ...outsideMark(outside),
    ];
  }

  private async latest<T>(runKey: string, artifact: { kind: string; parse(body: string): T }): Promise<T | null> {
    const body = await this.documents.latestBody(runKey, artifact.kind);
    return body === null ? null : artifact.parse(body);
  }

  private async unmetItems(runKey: string) {
    const review = await this.latest(runKey, ARTIFACTS.reviewRequirementsResult);
    return (review?.requirements ?? []).filter((mark) => mark.status !== 'met');
  }

  private unmetMarks(unmet: { id: string; status: string; note: string }[]): string[] {
    return unmet.map((mark) => `requirement ${mark.id} is ${mark.status}: ${mark.note}`);
  }

  private async notBuilt(runKey: string): Promise<string[]> {
    return handoffText(await this.latest(runKey, ARTIFACTS.handoff))
      .split('\n')
      .map((line) => line.replace(/^[-*\s]+/, '').trim())
      .filter((line) => line.startsWith('not built:') && line !== 'not built: nothing');
  }

  private async plannedFiles(runKey: string): Promise<string[]> {
    return ((await currentPlan(this.documents, runKey))?.items ?? []).flatMap(itemFiles);
  }

  /** The files the merge request changed: the stored merged files, else the paths of the commit, with the repository when it names several. */
  private async changedFiles(runKey: string): Promise<string[]> {
    const stored = await mergedFilesOf(this.documents, runKey);
    if (stored.length > 0) return stored;
    const paths = parsePaths((await this.documents.latestBody(runKey, ARTIFACTS.commit.kind)) ?? '');
    const several = new Set(paths.map((item) => item.repo)).size > 1;
    return paths.map((item) => (several ? `${item.repo}/${item.path}` : item.path));
  }
}
