import type { ResearchResult } from '../../agent-result/definitions/research';
import { legacyQuestions } from '../../agent-result/legacy/research';
import { renderQuestions } from '../research/research-record';

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
 * The open questions of a stored `questions` document. Research and plan both write it, so the object of
 * `research_result` counts only while the stored body is what it rendered; it keeps a multi-line question whole.
 * Any other body is read as it was written.
 */
export function openQuestions(questionsBody: string, result: ResearchResult | null): string[] {
  if (!questionsBody.trim()) return [];
  if (result && questionsBody === renderQuestions(result.questions)) return result.questions;
  return legacyQuestions(questionsBody);
}

export function unanswered(questionsBody: string, result: ResearchResult | null, answersBody: string): string[] {
  const stored = answered(answersBody);
  return openQuestions(questionsBody, result).filter((question) => !(stored.get(question) ?? '').trim());
}
