import type { StepStatEntity } from '../../history/step-stat.entity';
import { reportPath } from './report-path';

function visit(id: number, step: string, status: string): StepStatEntity {
  return { id, step, status } as StepStatEntity;
}

describe('report path', () => {
  it('lists implement once, each return, the last review and CI', () => {
    const stats = [
      visit(1, 'implement', 'done'),
      visit(2, 'checks', 'waiting'),
      visit(3, 'implement', 'done'),
      visit(4, 'checks', 'done'),
      visit(5, 'code-review', 'waiting'),
      visit(6, 'implement', 'done'),
      visit(7, 'checks', 'done'),
      visit(8, 'code-review', 'done'),
      visit(9, 'commit', 'done'),
      visit(10, 'pipeline', 'waiting'),
      visit(11, 'pipeline', 'done'),
    ];
    const path = reportPath(stats, []).map((item) => `${item.step} ${item.mark}`.trim());
    expect(path).toEqual(['implement', 'checks ❌', 'review ↩', 'review ✅', 'CI 🟢']);
  });
});
