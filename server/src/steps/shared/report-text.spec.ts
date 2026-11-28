import type { ReviewReportResult } from '../../agent-result/definitions/review-report';
import { CODE_REVIEWERS } from '../../contract/steps';
import type { ReportFacts, ReviewerFact } from './report-facts';
import { renderRunReport } from './report-text';

const reviewer = (name: ReviewerFact['name'], extra: Partial<ReviewerFact> = {}): ReviewerFact => ({
  name,
  decision: 'ok',
  exchange: null,
  ...extra,
});

const FACTS: ReportFacts = {
  verdict: 'ready',
  requirements: { met: 9, total: 9 },
  checks: { passed: 12, total: 12 },
  ci: 'passed',
  review: { ok: 3, total: 3 },
  returns: { count: 2, fixed: true },
  durationMs: 38 * 60_000,
  path: [
    { step: 'implement', mark: '', returned: false, reason: null, fix: null },
    { step: 'checks', mark: '❌', returned: true, reason: 'lint (`import type`)', fix: 'fixed' },
    {
      step: 'review',
      mark: '↩',
      returned: true,
      reason: 'security: a committed symlink could pull a host file into the prompt',
      fix: '`lstatSync`',
    },
    { step: 'review', mark: '✅', returned: false, reason: null, fix: null },
    { step: 'CI', mark: '🟢', returned: false, reason: null, fix: null },
  ],
  reviewers: CODE_REVIEWERS.map((name) => reviewer(name)),
};

const PARTS: ReviewReportResult = {
  line: "Every agent step now gets each repository's `AGENTS.md` exactly once, on any runtime.",
  done: [
    'New `project-rules.ts` adds a `Project rules (<repo>):` section to every skill prompt.',
    'Each runtime declares the rule files its CLI loads by itself.',
  ],
  worthALook: [
    {
      place: 'steps/shared/project-rules.ts',
      reason: 'the first mount is skipped when the runtime loads `AGENTS.md`.',
    },
    { place: 'steps/shared/limit-failover.ts', reason: 'failover now rebuilds the prompt for the new runtime.' },
  ],
  notes: {
    requirements: 'Both earlier findings are fixed.',
    code: 'Nothing new; `lstatSync` blocks a symlink.',
    behavior: 'Failover still prefers the prompt built for the new runtime; one `lstat` per mount.',
  },
  risk: 'low',
  riskReason: 'a contained change',
};

const EXAMPLE = `## ✅ Ready to merge · risk: low
> Every agent step now gets each repository's \`AGENTS.md\` exactly once, on any runtime.

| Requirements | Checks | CI | Review | Returns | Time |
|---|---|---|---|---|---|
| 9/9 met | 12/12 | 🟢 | 3/3 ok | 2, both fixed | 38 min |

**Done**
- New \`project-rules.ts\` adds a \`Project rules (<repo>):\` section to every skill prompt.
- Each runtime declares the rule files its CLI loads by itself.

**🔍 Worth a look**
1. \`steps/shared/project-rules.ts\`: the first mount is skipped when the runtime loads \`AGENTS.md\`.
2. \`steps/shared/limit-failover.ts\`: failover now rebuilds the prompt for the new runtime.

**🧭 How it got here**
implement → checks ❌ lint (\`import type\`) → fixed → review ↩ security: a committed symlink could pull a host file into the prompt → \`lstatSync\` → review ✅ → CI 🟢

<details><summary>Reviewer notes (3)</summary>

- **Requirements ✅** Both earlier findings are fixed.
- **Code ✅** Nothing new; \`lstatSync\` blocks a symlink.
- **Behavior ✅** Failover still prefers the prompt built for the new runtime; one \`lstat\` per mount.
</details>
`;

describe('renderRunReport', () => {
  it("renders the brief's example exactly from facts and parts", () => {
    expect(renderRunReport(FACTS, PARTS)).toBe(EXAMPLE);
  });

  it('renders the notes of the retired reviewers of an old run by their own labels', () => {
    const names = ['requirements', 'quality', 'regressions', 'security', 'performance'] as const;
    const notes = Object.fromEntries(names.map((name) => [name, `${name} note`]));
    const text = renderRunReport({ ...FACTS, reviewers: names.map((name) => reviewer(name)) }, { ...PARTS, notes });
    expect(text).toContain('Reviewer notes (5)');
    expect(text).toContain('- **Quality ✅** quality note');
    expect(text).toContain('- **Performance ✅** performance note');
  });

  it('renders a reviewer without a note as an empty note', () => {
    const text = renderRunReport(FACTS, { ...PARTS, notes: { requirements: 'Fixed.' } });
    expect(text).toContain('- **Behavior ✅** \n');
  });

  it('shows a run sent back with its reason in the path', () => {
    const facts: ReportFacts = {
      ...FACTS,
      verdict: 'sent-back',
      ci: 'waiting',
      returns: { count: 1, fixed: false },
      path: [
        { step: 'implement', mark: '', returned: false, reason: null, fix: null },
        { step: 'review', mark: '↩', returned: true, reason: 'quality: a test is missing', fix: null },
      ],
      reviewers: CODE_REVIEWERS.map((name) => reviewer(name, name === 'code' ? { decision: 'return' } : {})),
    };
    const text = renderRunReport(facts, PARTS);
    expect(text).toContain('## ↩ Sent back · risk: low');
    expect(text).toContain('implement → review ↩ quality: a test is missing\n');
    expect(text).toContain('| 1 |');
    expect(text).toContain('- **Code ↩** Nothing new; `lstatSync` blocks a symlink.');
  });

  it('shows a run that waits for CI', () => {
    const text = renderRunReport({ ...FACTS, verdict: 'waiting', ci: 'waiting' }, PARTS);
    expect(text).toContain('## ⏳ Waiting for CI · risk: low');
    expect(text).toContain('| 9/9 met | 12/12 | ⏳ |');
  });

  it('shows a failed CI', () => {
    const text = renderRunReport({ ...FACTS, verdict: 'ci-failed', ci: 'failed' }, PARTS);
    expect(text).toContain('## ❌ CI failed · risk: low');
    expect(text).toContain('| 🔴 |');
  });

  it.each(['medium', 'high'] as const)('puts the reason of a %s risk under the table', (risk) => {
    const text = renderRunReport(FACTS, { ...PARTS, risk, riskReason: 'a new path\nwith a second line' });
    expect(text).toContain(`## ✅ Ready to merge · risk: ${risk}`);
    expect(text).toContain(
      '| 9/9 met | 12/12 | 🟢 | 3/3 ok | 2, both fixed | 38 min |\n\n**Risk:** a new path with a second line\n\n**Done**',
    );
  });

  it('shows a dash for each missing fact, and leaves out an empty Worth a look', () => {
    const facts: ReportFacts = {
      ...FACTS,
      requirements: null,
      checks: null,
      ci: null,
      review: null,
      durationMs: null,
      path: [],
      returns: { count: 0, fixed: false },
    };
    const text = renderRunReport(facts, { ...PARTS, worthALook: [] });
    expect(text).toContain('| — | — | — | — | 0 | — |');
    expect(text).not.toContain('Worth a look');
    expect(text).toContain('**🧭 How it got here**\n—\n');
  });

  it('shows a reviewer without a decision as a dash', () => {
    const facts = { ...FACTS, reviewers: CODE_REVIEWERS.map((name) => reviewer(name, { decision: null })) };
    expect(renderRunReport(facts, PARTS)).toContain('- **Code —** Nothing new; `lstatSync` blocks a symlink.');
  });

  it('writes hours and minutes for a long run, and a Tasks column before Time for a split parent', () => {
    const text = renderRunReport(
      { ...FACTS, durationMs: 135 * 60_000, tasks: { merged: 2, total: 3, lines: [] } },
      PARTS,
    );
    expect(text).toContain('| Returns | Tasks | Time |');
    expect(text).toContain('| 2, both fixed | 2/3 merged | 2 h 15 min |');
  });

  it('shows one How it got here line per task for a split parent', () => {
    const lines = ['Add the field: merged, 0', 'Wire the route: running, 1'];
    const text = renderRunReport({ ...FACTS, tasks: { merged: 1, total: 2, lines } }, PARTS);
    expect(text).toContain('| 1/2 merged |');
    expect(text).toContain('**🧭 How it got here**\n- Add the field: merged, 0\n- Wire the route: running, 1\n');
    expect(text).not.toContain('implement → checks');
  });

  it("shows the exchange under the reviewer: finding, implement's reason, the answer and the person's decision", () => {
    const exchange = {
      finding: 'The parser drops an\nempty segment.',
      reason: 'The empty segment is invalid input.',
      answer: 'Still a loss of data.',
      decision: 'Keep the segment.',
    };
    const facts = {
      ...FACTS,
      reviewers: CODE_REVIEWERS.map((name) => reviewer(name, name === 'code' ? { decision: 'return', exchange } : {})),
    };
    expect(renderRunReport(facts, PARTS)).toContain(
      [
        '- **Code ↩** Nothing new; `lstatSync` blocks a symlink.',
        '  - Finding not fixed: The parser drops an empty segment.',
        "  - Implement's reason: The empty segment is invalid input.",
        '  - Code answered: Still a loss of data.',
        '  - The person decided: Keep the segment.',
        '- **Behavior ✅**',
      ].join('\n'),
    );
  });

  it('names no step, document kind or field of the system', () => {
    const text = renderRunReport(FACTS, PARTS);
    for (const word of [
      'code-review',
      'merge-request',
      'implement-improve',
      'review_report',
      'worthALook',
      'riskReason',
    ]) {
      expect(text).not.toContain(word);
    }
  });
});
