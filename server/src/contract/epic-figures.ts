/** What an epic's figures add up from. `workedMs` is the tasks' step time added up, null when no task started. */
interface EpicParts {
  epicUsd: number;
  ownUsd: number;
  epicMs: number;
  taskCount: number;
  workedMs: number | null;
}

/** The figures an epic shows on the run page and in the run list, each with the parts it adds up from. */
interface EpicFigures {
  time: string;
  timeTip: string;
  money: string;
  moneyTip: string;
  /** The tasks' money: the epic's money without the parent's own. */
  tasksMoney: string;
  /** `agents worked 8h 0m`, or empty when no task started. */
  workedTip: string;
}

export function epicFigures(
  parts: EpicParts,
  format: { money: (usd: number) => string; duration: (ms: number) => string },
): EpicFigures {
  const tasksMoney = format.money(parts.epicUsd - parts.ownUsd);
  const tasks = `${parts.taskCount} ${parts.taskCount === 1 ? 'task' : 'tasks'}`;
  return {
    time: format.duration(parts.epicMs),
    timeTip: 'since the epic started',
    money: format.money(parts.epicUsd),
    moneyTip: `epic ${format.money(parts.ownUsd)} + ${tasks} ${tasksMoney}`,
    tasksMoney,
    workedTip: parts.workedMs === null ? '' : `agents worked ${format.duration(parts.workedMs)}`,
  };
}
