import type { DocumentEntity, RunEntity } from '../../history/entities';
import type { Subtask } from '../../contract/subtask';
import { questionFor } from '../implement/split-questions';
import { renderQuestions } from '../research/research-record';
import { openItems } from './open-items';

const AT = '2026-01-01T00:00:00.000Z';
const epic = { split: true, currentStep: 'implement' } as RunEntity;

const task = (id: string, status: Subtask['status']): Subtask => ({
  id,
  title: id,
  description: id,
  depends: [],
  files: [],
  proof: id,
  status,
});

const stored = (tasks: Subtask[], lines: string[]): DocumentEntity[] =>
  [
    { kind: 'subtasks', body: JSON.stringify(tasks) },
    { kind: 'subtask_questions', body: renderQuestions(lines) },
  ] as DocumentEntity[];

describe('the open items of an epic at implement', () => {
  it("lists a question of a task that is not skipped and drops the skipped task's", () => {
    const lines = [questionFor('a', 'Which one?', AT), questionFor('b', 'And this?', AT), questionFor('c', 'Why?', AT)];

    const items = openItems(epic, stored([task('a', 'running'), task('b', 'skipped'), task('c', 'merged')], lines), []);

    expect(items.map((item) => item.id)).toEqual([lines[0], lines[2]]);
  });
});
