interface ImpactItem {
  capability: string;
  file: string;
  status: string;
}

function bullets(lines: string[]): string {
  return lines.length === 0 ? '' : `${lines.map((line) => `- ${line}`).join('\n')}\n`;
}

/** The stored `questions` document: one bullet per open question. No question is an empty body. */
export function renderQuestions(questions: string[]): string {
  return bullets(questions);
}

export function renderImpact(list: ImpactItem[]): string {
  return bullets(list.map((item) => `${item.capability} | ${item.file} | ${item.status}`));
}
