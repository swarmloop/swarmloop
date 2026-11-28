import type { AnsweredQuestion, PassedOn, StoredQuestion } from '../shared/question-parts';
import { artifact, firstLine, jsonArrayCodec, listSummary, type Artifact } from './artifact';

/** The kinds of a question's way to a person and back; `ARTIFACTS` spreads them. */
export const QUESTION_ARTIFACTS = {
  answers: artifact('answers', {
    writers: [],
    readers: ['research', 'plan', 'implement'],
    external: true,
    summarize: firstLine,
  }),
  questions: artifact('questions', { writers: ['research', 'plan'], readers: ['plan'], summarize: firstLine }),
  // What the code review asks the person when a reviewer returns the same diff again; `answers` closes it.
  reviewQuestions: artifact('review_questions', {
    writers: ['code-review'],
    readers: ['implement'],
    summarize: firstLine,
  }),
  // The open questions of review_questions and subtask_questions in parts; the text of a question is the key to its parts.
  questionParts: artifact('question_parts', {
    writers: ['code-review', 'implement'],
    readers: ['implement'],
    codec: jsonArrayCodec<StoredQuestion>(),
    summarize: (questions) => listSummary(questions.length, 'questions', questions[0]?.parts.decide),
  }),
  // The questions of a backlog's run that the backlog's planner passed on to the person, each with its line; written by the pass-on service.
  passedOn: artifact('passed_on', {
    writers: [],
    readers: [],
    external: true,
    codec: jsonArrayCodec<PassedOn>(),
    summarize: (passed) => listSummary(passed.length, 'passed on questions', passed[0]?.line),
  }),
  // The questions a person answered on this run, so none is asked again; written by the server, reread by the steps that ask.
  answeredQuestions: artifact('answered_questions', {
    writers: [],
    readers: ['code-review', 'implement'],
    external: true,
    codec: jsonArrayCodec<AnsweredQuestion>(),
    summarize: (answered) => listSummary(answered.length, 'answered questions', answered[0]?.decide),
  }),
} as const satisfies Record<string, Artifact<unknown>>;
