import { SwarmloopError } from '../../swarmloop-error';
import { bulletList, items, section } from '../shared/markdown-section';

export interface ResearchRecord {
  questions: string;
}

export function parseResearch(text: string): ResearchRecord {
  const questionsBlock = section(text, 'questions');
  if (questionsBlock === null) {
    throw new SwarmloopError('questions is missing');
  }
  const questions = items(questionsBlock).filter((item) => item !== 'none');
  return { questions: bulletList(questions) };
}
