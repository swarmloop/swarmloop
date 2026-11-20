import { CONTRACT_KIND, SUBTASKS_KIND, type Subtask } from '../../contract/subtask';
import { subtaskAnswer, type SubtaskAnswerResult } from '../../agent-result/definitions/subtask-answer';
import { starterAnswer, type StarterAnswerResult } from '../../agent-result/definitions/starter-answer';
import { resultArtifactCodec } from '../../agent-result/result-codec';
import { artifact, firstLine, jsonArrayCodec, listSummary, type Artifact } from './artifact';

/** The kinds of a split run and its subtasks; `ARTIFACTS` spreads them. */
export const SPLIT_ARTIFACTS = {
  subtaskQuestions: artifact('subtask_questions', {
    writers: ['implement'],
    readers: ['implement'],
    summarize: firstLine,
  }),
  // The parent planner's answer to a subtask, written by the pipeline and not by a step.
  subtaskAnswerResult: artifact(subtaskAnswer.kind, {
    writers: [],
    readers: [],
    external: true,
    codec: resultArtifactCodec<SubtaskAnswerResult>(subtaskAnswer),
    summarize: (result) => firstLine(result.answer),
  }),
  // What a run's planner answers to a run it started: a decision and the actions that follow, written by the pipeline.
  starterAnswerResult: artifact(starterAnswer.kind, {
    writers: [],
    readers: [],
    external: true,
    codec: resultArtifactCodec<StarterAnswerResult>(starterAnswer),
    summarize: (result) => firstLine(result.decision),
  }),
  /** What a subtask handed to its starter: a question, decisions, parts left out. Written by the pipeline. */
  starterReport: artifact('starter_report', { writers: [], readers: [], external: true, summarize: firstLine }),
  /** What a subtask was last told by its starter, per chat, so a continued chat gets only what changed. */
  starterBriefing: artifact('starter_briefing', { writers: [], readers: [], external: true, summarize: firstLine }),
  /** What a subtask's chats already took from its starter. */
  starterTaken: artifact('starter_taken', {
    writers: ['implement'],
    readers: [],
    external: true,
    summarize: firstLine,
  }),
  /** The starter's look at a merged task. */
  mergeLook: artifact('merge_look', { writers: [], readers: [], external: true, summarize: firstLine }),
  subtasks: artifact(SUBTASKS_KIND, {
    writers: ['plan', 'plan-improve', 'implement'],
    readers: ['plan-improve', 'branch', 'implement', 'implement-improve'],
    codec: jsonArrayCodec<Subtask>(),
    summarize: (tasks) => listSummary(tasks.length, 'tasks', tasks[0]?.title),
  }),
  contract: artifact(CONTRACT_KIND, {
    writers: ['plan', 'plan-improve', 'implement'],
    readers: ['plan-improve', 'implement', 'implement-improve'],
    summarize: firstLine,
  }),
  /** The files a merged task changed, one path per line, read from its merge into the feature branch. */
  mergedFiles: artifact('merged_files', { writers: [], readers: [], external: true, summarize: firstLine }),
} as const satisfies Record<string, Artifact<unknown>>;
