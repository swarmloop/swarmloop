import { existsSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { GOLDEN_DIR } from './step-trace.spec-helpers';

const BASELINE = join(__dirname, 'prompt-budget.baseline.json');
/** A step's first prompt may grow by this share of the size it had before the result format. */
const BUDGET = 0.1;

interface Golden {
  visits?: { exchanges?: { requestText?: string }[] }[];
}

/** The size, in characters, of the first prompt of the first visit that started an agent. */
function firstPromptSize(file: string): number | null {
  const golden = JSON.parse(readFileSync(join(GOLDEN_DIR, file), 'utf8')) as Golden;
  for (const visit of golden.visits ?? []) {
    const text = visit.exchanges?.[0]?.requestText;
    if (text !== undefined) {
      return text.length;
    }
  }
  return null;
}

function currentSizes(): Record<string, number> {
  const sizes: Record<string, number> = {};
  for (const file of readdirSync(GOLDEN_DIR).filter((name) => name.endsWith('.json'))) {
    const size = firstPromptSize(file);
    if (size !== null) {
      sizes[file] = size;
    }
  }
  return sizes;
}

/** Records today's sizes. Run once on the tree before any prompt changes: `UPDATE_PROMPT_BUDGET=1`. */
if (process.env.UPDATE_PROMPT_BUDGET === '1' && !process.env.CI && !existsSync(BASELINE)) {
  writeFileSync(BASELINE, `${JSON.stringify(currentSizes(), null, 2)}\n`);
}

const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, number>;
const sizes = currentSizes();

describe('prompt budget', () => {
  it('names every golden trace that starts an agent', () => {
    expect(Object.keys(baseline).sort()).toEqual(Object.keys(sizes).sort());
  });

  it.each(Object.entries(baseline))('%s keeps its first prompt within the budget', (file, before) => {
    expect(sizes[file]).toBeLessThanOrEqual(Math.floor(before * (1 + BUDGET)));
  });
});
