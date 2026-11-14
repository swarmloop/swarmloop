import { legacyQuestions } from '../../agent-result/legacy/research';
import { renderQuestions } from '../research/research-record';

/** A stored result that may have asked: the questions it rendered into the `questions` document. */
interface Asked {
  questions: string[];
}

/**
 * The answers of a person by question. A question may span lines: its text runs from `question: ` to the `answer: `
 * line, and the answer runs to the next `question: `.
 */
export function answered(body: string): Map<string, string> {
  const stored = new Map<string, string>();
  let question: string[] | null = null;
  let lines: string[] | null = null;
  const flush = (): void => {
    if (question) {
      stored.set(question.join('\n').trim(), (lines ?? []).join('\n').trim());
    }
    question = null;
    lines = null;
  };
  for (const line of body.split('\n')) {
    if (line.startsWith('question: ')) {
      flush();
      question = [line.slice('question: '.length)];
    } else if (question && lines === null && line.startsWith('answer: ')) {
      lines = [line.slice('answer: '.length)];
    } else if (lines) {
      lines.push(line);
    } else if (question) {
      question.push(line);
    }
  }
  flush();
  return stored;
}

/**
 * The open questions of a stored `questions` document. Research and plan both write it, so the object of a stored
 * result counts only while the stored body is what it rendered; it keeps a multi-line question whole.
 * Any other body is read as it was written.
 */
export function openQuestions(questionsBody: string, results: (Asked | null)[]): string[] {
  if (!questionsBody.trim()) return [];
  const own = results.find((result) => result && questionsBody === renderQuestions(result.questions));
  return own ? own.questions : legacyQuestions(questionsBody);
}

export function unanswered(questionsBody: string, results: (Asked | null)[], answersBody: string): string[] {
  const stored = answered(answersBody);
  return openQuestions(questionsBody, results).filter((question) => !(stored.get(question) ?? '').trim());
}
