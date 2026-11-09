import { SwarmloopError } from '../../core/swarmloop-error';

const ENDINGS: Record<string, string> = {
  research: 'impact:\n- capability | file | kept\n\nsummary:\n- why\n\nquestions:\n- none',
  plan: 'plan:\n- item\n\nsummary:\n- why',
  'plan-improve': 'plan:\n- item\n\nsummary:\n- why',
  implement: 'implementation:\n- item\n\nsummary:\n- why',
  'implement-improve': 'implementation:\n- item\n\nsummary:\n- why',
  'code-review': 'decision: ok',
  'code-review/report': '## What changed\n\n## Code review\n\n## What holds\n\n## What to fix',
};

export function answerEnding(step: string): string | null {
  return ENDINGS[step] ?? null;
}

export function parseFailureFollowUp(error: unknown, ending: string | null): string | null {
  if (!(error instanceof SwarmloopError) || !/^[a-z_ -]+ is (missing|empty)$/.test(error.message) || !ending) {
    return null;
  }
  const name = error.message.replace(/ is (missing|empty)$/, '');
  return [
    `Your answer is missing the ${name} section. Do not redo the work.`,
    'End your answer with exactly this block:',
    '',
    ending,
  ].join('\n');
}
