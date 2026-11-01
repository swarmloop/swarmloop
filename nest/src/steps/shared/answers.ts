import { items } from './markdown-section';

export function answered(body: string): Map<string, string> {
  const stored = new Map<string, string>();
  let question = '';
  let lines: string[] = [];
  const flush = (): void => {
    if (question) {
      stored.set(question, lines.join('\n').trim());
    }
    question = '';
    lines = [];
  };
  for (const line of body.split('\n')) {
    if (line.startsWith('question: ')) {
      flush();
      question = line.slice('question: '.length).trim();
    } else if (line.startsWith('answer: ')) {
      lines = [line.slice('answer: '.length)];
    } else if (question) {
      lines.push(line);
    }
  }
  flush();
  return stored;
}

export function unanswered(questionsBody: string, answersBody: string): string[] {
  const stored = answered(answersBody);
  return items(questionsBody).filter((question) => !(stored.get(question) ?? '').trim());
}
