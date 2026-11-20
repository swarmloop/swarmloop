import type { EtaHistoryRepository } from '../history/eta-history.repository';
import type { RunWaitLog } from '../history/run-wait.log';
import { EtaSummary } from './eta-summary';

type Finished = Awaited<ReturnType<EtaHistoryRepository['finishedRuns']>>;

const MIN = 60_000;

function plainRun(id: number, implementMinutes: number): Finished[number] {
  const created = Date.parse('2026-01-01T00:00:00.000Z') + id * 60 * MIN;
  const entered = new Date(created).toISOString();
  return {
    id,
    kind: 'plain',
    createdAt: entered,
    mergedAt: null,
    steps: [
      {
        step: 'implement',
        enteredAt: entered,
        lastFinishedAt: new Date(created + implementMinutes * MIN).toISOString(),
      },
    ],
    waits: [],
  };
}

function setup() {
  let history: Finished = [plainRun(1, 10)];
  const listeners: ((key: string) => void)[] = [];
  const repository = { finishedRuns: async () => history } as unknown as EtaHistoryRepository;
  const waitLog = {
    onFinished: (listener: (key: string) => void) => listeners.push(listener),
  } as unknown as RunWaitLog;
  const summary = new EtaSummary(repository, waitLog);
  return {
    summary,
    setHistory: (runs: Finished) => (history = runs),
    finish: () => listeners.forEach((listener) => listener('run-1')),
  };
}

describe('EtaSummary', () => {
  it('follows the history read at first use and changes only after a run finishes', async () => {
    const { summary, setHistory, finish } = setup();
    expect((await summary.table()).plain.steps.implement).toBe(10 * MIN);

    setHistory([plainRun(1, 30)]);
    expect((await summary.table()).plain.steps.implement).toBe(10 * MIN);

    finish();
    expect((await summary.table()).plain.steps.implement).toBe(30 * MIN);
  });

  it('stops listening for finished runs on destroy', async () => {
    const { summary, setHistory, finish } = setup();
    await summary.table();
    summary.onModuleDestroy();
    setHistory([plainRun(1, 30)]);
    finish();
    expect((await summary.table()).plain.steps.implement).toBe(10 * MIN);
  });
});
