import { plannerFacts } from './planner-facts.spec-helpers';

type Harness = Awaited<ReturnType<typeof plannerFacts>>;

async function withReasons(body: (h: Harness) => Promise<void>): Promise<void> {
  const h = await plannerFacts();
  try {
    await body(h);
  } finally {
    await h.close();
  }
}

async function reasonOf(h: Harness, key: string): Promise<string | null> {
  const run = (await h.runs.findRun(key)) as NonNullable<Awaited<ReturnType<typeof h.runs.findRun>>>;
  return h.runReasons().of(run);
}

describe('RunReasons', () => {
  it('gives a failed run with no stored reason the last line of its step, without the time stamp', () =>
    withReasons(async (h) => {
      await h.addRun('a-1');
      await h.endRun(
        'a-1',
        'failed',
        'pipeline',
        '2026-01-01T10:00:00.000Z the code host refuses to read pipelines (HTTP 403)\nsecond line',
      );

      expect(await reasonOf(h, 'a-1')).toBe('pipeline step: the code host refuses to read pipelines (HTTP 403)');
    }));

  it('gives a blocked run its stored code and message, and the step line when the run stored none', () =>
    withReasons(async (h) => {
      await h.addRun('a-1');
      await h.addRun('a-2');
      await h.endRun('a-1', 'blocked', 'plan', 'needs an answer', { code: 'NEEDS_ANSWER', message: 'which library?' });
      await h.endRun('a-2', 'blocked', 'plan', 'needs an answer');

      expect(await reasonOf(h, 'a-1')).toBe('NEEDS_ANSWER: which library?');
      expect(await reasonOf(h, 'a-2')).toBe('plan step: needs an answer');
    }));

  it('gives no reason to a run that is neither failed nor blocked, or whose step recorded no end', () =>
    withReasons(async (h) => {
      await h.addRun('a-1');
      await h.addRun('a-2');
      await h.endRun('a-1', 'running', 'plan', 'still going');
      expect(await reasonOf(h, 'a-1')).toBeNull();

      const run = (await h.runs.findRun('a-2')) as NonNullable<Awaited<ReturnType<typeof h.runs.findRun>>>;
      expect(await h.runReasons().of({ ...run, state: 'failed', currentStep: 'pipeline' })).toBeNull();
    }));
});
