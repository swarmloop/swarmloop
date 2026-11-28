import type { QuestionParts } from '../../contract/api';
import type { ReviewResult } from '../../agent-result/definitions/review';

/** A question that waits for a person: the text answers are matched on, and the same question in parts. */
export interface StoredQuestion {
  question: string;
  parts: QuestionParts;
}

/** A question the backlog's planner passed on to the person: the question's text, the planner's one line and when. */
export interface PassedOn {
  question: string;
  line: string;
  at: string;
}

/** One planner's words on a question that went up the chain. */
export interface PlannerLine {
  who: string;
  text: string;
}

/** A question a person answered: who asked, what was decided, the answer and when. */
export interface AnsweredQuestion {
  asker: string;
  decide: string;
  answer: string;
  at: string;
}

/** Who asked and the plan chat entry the question came from. */
type QuestionSource = Pick<QuestionParts, 'asker' | 'entry'>;

const NO_ANSWER = 'Implement did not answer this point';

/** One reviewer's last finding and what implement answered to it. */
interface Disagreement {
  finding: string;
  answer: string | null;
}

/**
 * The parts of a review disagreement. The reviewer side comes from the structured result only: the marks that are
 * not met as `<id> is <missing|partial>: <note>`, else the reviewer's reason. The implement side is the exchange answer.
 */
export function reviewParts(
  reviewer: string,
  exchange: Disagreement,
  result: ReviewResult,
  askedAt: string,
): QuestionParts {
  const unmet = (result.requirements ?? []).filter((mark) => mark.status !== 'met');
  const point = unmet.length > 0 ? unmet.map((mark) => `${mark.id} is ${mark.status}`) : [reasonOf(result)];
  const reviewerSide =
    unmet.length > 0 ? unmet.map((mark) => `${mark.id} is ${mark.status}: ${mark.note.trim()}`) : point;
  return {
    decide: `Is the ${reviewer} review right that ${point.join(', ')}?`,
    sides: [
      { who: reviewer, text: reviewerSide.join('\n') },
      { who: 'implement', text: exchange.answer?.trim() || NO_ANSWER },
    ],
    full: exchange.finding.trim(),
    askedAt,
    asker: `code-review-${reviewer}`,
  };
}

function reasonOf(result: ReviewResult): string {
  return result.reason?.trim() || 'the change still needs a fix';
}

/** The parts of a subtask question the planner could not answer, and of a refused `needs:`. */
export function askedParts(
  question: string,
  askedAt: string,
  source: QuestionSource = {},
  lines: PlannerLine[] = [],
): QuestionParts {
  return {
    decide: question.trim(),
    sides: lines.length > 0 ? lines : [{ who: 'planner', text: 'The planner gave no answer.' }],
    full: '',
    askedAt,
    ...source,
  };
}

function collapsed(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The answer already given to this asker's question, matched on the decide text without its whitespace; else null. */
export function answeredBefore(record: AnsweredQuestion[], asker: string, decide: string): string | null {
  const wanted = collapsed(decide);
  return record.find((item) => item.asker === asker && collapsed(item.decide) === wanted)?.answer ?? null;
}

/** The stored parts of the questions that are still open, then the questions asked now. */
export function keepOpen(stored: StoredQuestion[], open: string[], asks: StoredQuestion[]): StoredQuestion[] {
  return [...stored.filter((item) => open.includes(item.question)), ...asks];
}

/** The stored list, or an empty one when the body is not a list of questions. */
export function readStoredQuestions(body: string): StoredQuestion[] {
  try {
    const parsed: unknown = JSON.parse(body);
    return Array.isArray(parsed)
      ? (parsed as StoredQuestion[]).filter((item) => typeof item?.question === 'string')
      : [];
  } catch {
    return [];
  }
}
