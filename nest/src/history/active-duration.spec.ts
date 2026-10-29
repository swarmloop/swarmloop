import { activeDurationMs, DurationPart } from './active-duration';

function part(step: string, durationMs: number, extra: Partial<DurationPart> = {}): DurationPart {
  return {
    step,
    durationMs,
    stepStartedAt: '2026-10-28T10:01:00.000Z',
    startedAt: '2026-10-28T10:01:00.000Z',
    finishedAt: '2026-10-28T10:01:30.000Z',
    reportMs: 0,
    ...extra,
  };
}

function untimed(step: string, durationMs: number, startedAt: string, finishedAt: string, reportMs = 0): DurationPart {
  return part(step, durationMs, { stepStartedAt: null, startedAt, finishedAt, reportMs });
}

describe('activeDurationMs', () => {
  it('adds each step, the longest code-review reviewer, the report, and the rest of that visit', () => {
    const total = activeDurationMs([
      part('implement', 1_000, { stepStartedAt: '2026-10-28T10:00:00.000Z' }),
      part('code-review-quality', 8_000),
      part('code-review-security', 3_000),
      part('code-review', 11_000, { reportMs: 2_000 }),
      part('pipeline', 500, { stepStartedAt: '2026-10-28T10:02:00.000Z' }),
    ]);

    expect(total).toBe(1_000 + 8_000 + 2_000 + 1_000 + 500);
  });

  it('counts a later code-review visit on its own', () => {
    const total = activeDurationMs([
      part('code-review-quality', 8_000),
      part('code-review', 11_000, { reportMs: 2_000 }),
      part('code-review-quality', 4_000, { stepStartedAt: '2026-10-28T11:00:00.000Z' }),
      part('code-review-security', 1_000, { stepStartedAt: '2026-10-28T11:00:00.000Z' }),
      part('code-review', 9_000, { stepStartedAt: '2026-10-28T11:00:00.000Z', reportMs: 3_000 }),
    ]);

    expect(total).toBe(11_000 + 9_000);
  });

  it('keeps a code-review visit that recorded no separate reviewers', () => {
    expect(activeDurationMs([part('code-review', 4_000)])).toBe(4_000);
  });

  it('leaves an open code-review visit to the live clock', () => {
    expect(
      activeDurationMs([
        part('implement', 1_000, { stepStartedAt: '2026-10-28T10:00:00.000Z' }),
        part('code-review-quality', 8_000),
        part('code-review-security', 3_000),
      ]),
    ).toBe(1_000);
  });

  it('keeps reviewer and report time when the visit row is shorter than that work', () => {
    const total = activeDurationMs([
      part('code-review-quality', 8_000),
      part('code-review-security', 3_000),
      part('code-review', 1_000, { reportMs: 2_000 }),
    ]);

    expect(total).toBe(8_000 + 2_000);
  });

  it('does not match a reviewer to a visit when only one of them stored the visit start', () => {
    const total = activeDurationMs([part('code-review-quality', 8_000), part('code-review', 1_000, { stepStartedAt: null, reportMs: 500 })]);

    expect(total).toBe(1_000);
  });

  it('adds the implementation between loop backs and keeps each code-review pass separate', () => {
    const total = activeDurationMs([
      part('implement', 200_000, { stepStartedAt: '2026-10-28T10:27:33.166Z' }),
      part('implement-review', 50_000, { stepStartedAt: '2026-10-28T10:31:02.727Z' }),
      part('code-review-quality', 409_599, { stepStartedAt: '2026-10-28T10:31:53.641Z' }),
      part('code-review-security', 259_340, { stepStartedAt: '2026-10-28T10:31:53.641Z' }),
      part('code-review', 453_238, { stepStartedAt: '2026-10-28T10:31:53.641Z', reportMs: 42_424 }),
      part('implement', 68_826, { stepStartedAt: '2026-10-28T11:09:56.361Z' }),
      part('implement-review', 22_418, { stepStartedAt: '2026-10-28T11:11:06.676Z' }),
      part('code-review-quality', 47_840, { stepStartedAt: '2026-10-28T11:11:29.817Z' }),
      part('code-review', 95_449, { stepStartedAt: '2026-10-28T11:11:29.817Z', reportMs: 43_342 }),
    ]);

    expect(total).toBe(200_000 + 50_000 + 453_238 + 68_826 + 22_418 + 95_449);
  });

  it('matches reviewers to a visit by time when no visit start was stored', () => {
    const total = activeDurationMs([
      untimed('code-review-quality', 3_000, '2026-10-28T10:00:01.000Z', '2026-10-28T10:00:04.000Z'),
      untimed('code-review', 5_000, '2026-10-28T10:00:00.000Z', '2026-10-28T10:00:05.000Z', 1_000),
      untimed('implement', 4_000, '2026-10-28T10:10:00.000Z', '2026-10-28T10:10:04.000Z'),
      untimed('code-review-quality', 4_000, '2026-10-28T10:20:01.000Z', '2026-10-28T10:20:05.000Z'),
      untimed('code-review-security', 11_000, '2026-10-28T10:20:01.000Z', '2026-10-28T10:20:12.000Z'),
      untimed('code-review', 12_000, '2026-10-28T10:20:00.000Z', '2026-10-28T10:20:12.000Z', 2_000),
    ]);

    expect(total).toBe(5_000 + 4_000 + 11_000 + 2_000);
  });
});
