import { epicFigures } from './epic-figures';

const format = {
  money: (usd: number) => `$${usd.toFixed(2)}`,
  duration: (ms: number) => `${Math.round(ms / 60000)}m`,
};
const parts = { epicUsd: 33.52, ownUsd: 11.12, epicMs: 287 * 60000, taskCount: 12, workedMs: 480 * 60000 };

describe('epicFigures', () => {
  it('adds the parent and the tasks up to the epic money, and says so in the tip', () => {
    const figures = epicFigures(parts, format);
    expect(figures.money).toBe('$33.52');
    expect(figures.tasksMoney).toBe('$22.40');
    expect(figures.moneyTip).toBe('epic $11.12 + 12 tasks $22.40');
    expect(Number(figures.tasksMoney.slice(1)) + parts.ownUsd).toBeCloseTo(parts.epicUsd);
  });

  it('names the clock and the added-up agent time without the words total or this run', () => {
    const figures = epicFigures(parts, format);
    expect(figures.timeTip).toBe('since the epic started');
    expect(figures.workedTip).toBe('agents worked 480m');
    for (const label of Object.values(figures)) {
      expect(label).not.toMatch(/total|this run/);
    }
  });

  it('has no worked tip when no task started', () => {
    expect(epicFigures({ ...parts, workedMs: null }, format).workedTip).toBe('');
  });
});
