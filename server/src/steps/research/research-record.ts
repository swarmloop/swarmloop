import { SwarmloopError } from '../../core/swarmloop-error';
import { bulletList, items, section } from '../shared/markdown-section';

interface ResearchRecord {
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

const IMPACT_STATUSES = ['kept', 'changed', 'removed', 'unreachable'] as const;

interface ImpactItem {
  capability: string;
  file: string;
  status: string;
}

/** The `impact:` list of an answer. A missing section is an empty list; a line that is not `<capability> | <file> | <status>` is dropped with a note. */
export function parseImpact(text: string): { items: ImpactItem[]; notes: string[] } {
  const found: ImpactItem[] = [];
  const notes: string[] = [];
  for (const line of items(section(text, 'impact') ?? '').filter((item) => item !== 'none')) {
    const [capability, file, status, ...extra] = line.split('|').map((part) => part.trim());
    const base = status?.split(' ')[0] ?? '';
    if (!capability || !file || extra.length > 0 || !IMPACT_STATUSES.some((known) => known === base)) {
      notes.push(`ignored impact line: ${line}`);
    } else {
      found.push({ capability, file, status });
    }
  }
  return { items: found, notes };
}

export function renderImpact(list: ImpactItem[]): string {
  return bulletList(list.map((item) => `${item.capability} | ${item.file} | ${item.status}`));
}
