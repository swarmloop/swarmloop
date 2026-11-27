import { CONTRACT_KIND, isSubtask, parseSubtasks, SUBTASKS_KIND, type Subtask } from '../../contract/subtask';
import type { DocumentRepository } from '../../history/document.repository';
import type { RunEntity } from '../../history/entities';
import type { RunRepository } from '../../history/run.repository';
import { storedState } from '../../history/run-state';
import { ARTIFACTS } from '../contract/artifacts';
import { BriefingRecords, type BriefingRecord } from './briefing-record';
import { briefingState, recordOf, renderDelta, renderFull, type BriefingState } from './briefing-state';
import { mergeSummaryOf } from './merge-summary';
import { mergedFilesOf } from './merged-files';
import type { TaskRuns } from './task-map';

/** The steps whose prompt carries the starter's state: every step of a subtask that talks to an agent about its task. */
const BRIEFED_STEPS: readonly string[] = ['research', 'plan', 'implement', 'implement-improve'];
const REVIEWER_STEP = 'code-review-';

const isBriefed = (step: string): boolean => BRIEFED_STEPS.includes(step) || step.startsWith(REVIEWER_STEP);

/** The task of a run the parent's task list does not name: it depends on nothing and serves no requirement. */
function bareTask(id: string): Subtask {
  return { id, title: id, description: '', depends: [], files: [], proof: '', status: 'running' };
}

/** What a launch is told, and what its chat has then seen. */
interface PreparedBriefing {
  /** For the prompt that goes to the chat: the whole state for a new chat, what changed for a continued one. */
  told: string;
  /** For a prompt that starts a chat: the whole state. */
  full: string;
  record: BriefingRecord;
}

/**
 * What a run that was started by another run is told beyond its own inputs: the task map, what its dependencies made,
 * the contract with its decisions and the requirement ids. It is built in this one place, for research, plan,
 * implement, implement-improve and code review alike.
 */
export class StarterBriefing {
  private readonly records: BriefingRecords;

  constructor(
    private readonly runs: Pick<RunRepository, 'findById' | 'children'>,
    private readonly documents: DocumentRepository,
  ) {
    this.records = new BriefingRecords(documents);
  }

  /**
   * The text for the first prompt of a launch, or null when the run is not a subtask or the step is not briefed.
   * A continued chat gets only what its record has not seen; a chat with no record gets the whole state.
   */
  async prepare(
    run: RunEntity,
    step: string,
    chatId: string | null,
    options: { continued: boolean },
  ): Promise<PreparedBriefing | null> {
    const state = isBriefed(step) ? await this.state(run) : null;
    if (!state) return null;
    const seen = options.continued && chatId ? await this.records.read(run.key, chatId) : null;
    return {
      told: seen ? renderDelta(state, seen) : renderFull(state),
      full: renderFull(state),
      record: recordOf(state),
    };
  }

  /** Notes what a chat was told. A chat that started anew has a new id, so it starts from this record alone. */
  remember(run: RunEntity, chatId: string, prepared: PreparedBriefing): Promise<void> {
    return this.records.write(run, chatId, prepared.record);
  }

  /** The whole state as it is now, for a reader that keeps no record, or an empty string for a run that is not a subtask. */
  async fullText(run: RunEntity): Promise<string> {
    const state = await this.state(run);
    return state ? renderFull(state) : '';
  }

  /** The files the task of a subtask lists in its parent's task map; none for a run that is not a subtask. */
  async ownFiles(run: RunEntity): Promise<string[]> {
    const parentId = run.parentRunId;
    const parent = isSubtask(run) && typeof parentId === 'number' ? await this.runs.findById(parentId) : null;
    if (!parent) return [];
    const tasks = parseSubtasks(await this.documents.latestBody(parent.key, SUBTASKS_KIND));
    return tasks.find((item) => item.id === run.taskId)?.files ?? [];
  }

  private async state(run: RunEntity): Promise<BriefingState | null> {
    const parentId = run.parentRunId;
    const parent = isSubtask(run) && typeof parentId === 'number' ? await this.runs.findById(parentId) : null;
    if (!parent) return null;
    const tasks = parseSubtasks(await this.documents.latestBody(parent.key, SUBTASKS_KIND));
    const task = tasks.find((item) => item.id === run.taskId) ?? bareTask(run.taskId ?? '');
    const children = await this.runs.children(parent);
    const runs: TaskRuns = {};
    const summaries: Record<string, string> = {};
    const changed: Record<string, string[]> = {};
    for (const child of children) {
      if (!child.taskId) continue;
      runs[child.taskId] = { state: storedState(child).state, currentStep: child.currentStep };
      if (!task.depends.includes(child.taskId)) continue;
      const summary = await mergeSummaryOf(this.documents, child.key);
      if (summary) summaries[child.taskId] = summary;
      const files = await mergedFilesOf(this.documents, child.key);
      if (files.length > 0) changed[child.taskId] = files;
    }
    const list = await this.documents.latestBody(parent.key, ARTIFACTS.requirementList.kind);
    return briefingState({
      tasks,
      task,
      runs,
      summaries,
      changed,
      contract: (await this.documents.latestBody(parent.key, CONTRACT_KIND)) ?? '',
      requirements: list ? ARTIFACTS.requirementList.parse(list) : [],
    });
  }
}
