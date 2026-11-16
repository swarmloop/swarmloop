import type { ReviewReportResult } from '../../agent-result/definitions/review-report';
import type { ReportFacts, ReviewerFact, Verdict } from './report-facts';
import type { PathStep } from './report-path';

const HEADINGS: Record<Verdict, string> = {
  ready: '✅ Ready to merge',
  waiting: '⏳ Waiting for CI',
  'sent-back': '↩ Sent back',
  'ci-failed': '❌ CI failed',
};

const CI_MARKS: Record<NonNullable<ReportFacts['ci']>, string> = { passed: '🟢', failed: '🔴', waiting: '⏳' };

const DECISION_MARKS = { ok: '✅', return: '↩' } as const;

const MISSING = '—';

const MINUTES_PER_HOUR = 60;

function minutesText(minutes: number | null): string {
  if (minutes === null) {
    return MISSING;
  }
  return minutes < MINUTES_PER_HOUR
    ? `${minutes} min`
    : `${Math.floor(minutes / MINUTES_PER_HOUR)} h ${minutes % MINUTES_PER_HOUR} min`;
}

function returnsText(returns: ReportFacts['returns']): string {
  if (returns.count === 0 || !returns.fixed) {
    return String(returns.count);
  }
  return `${returns.count}, ${returns.count === 1 ? 'fixed' : returns.count === 2 ? 'both fixed' : 'all fixed'}`;
}

/** The header and the one row of the table, in the order a person reads them. */
function tableOf(facts: ReportFacts): string[] {
  const { requirements, checks, ci, review, tasks } = facts;
  const cells: [string, string][] = [
    ['Requirements', requirements ? `${requirements.met}/${requirements.total} met` : MISSING],
    ['Checks', checks ? `${checks.passed}/${checks.total}` : MISSING],
    ['CI', ci ? CI_MARKS[ci] : MISSING],
    ['Review', review ? `${review.ok}/${review.total} ok` : MISSING],
    ['Returns', returnsText(facts.returns)],
    ...(tasks === undefined
      ? []
      : [['Tasks', tasks ? `${tasks.merged}/${tasks.total} merged` : MISSING] as [string, string]]),
    ['Time', minutesText(facts.minutes)],
  ];
  return [
    `| ${cells.map(([title]) => title).join(' | ')} |`,
    `|${cells.map(() => '---').join('|')}|`,
    `| ${cells.map(([, value]) => value).join(' | ')} |`,
  ];
}

function pathText(step: PathStep): string {
  const marked = [step.step, step.mark, step.reason].filter(Boolean).join(' ');
  return step.fix ? `${marked} → ${step.fix}` : marked;
}

const oneLine = (text: string): string => text.trim().replace(/\s*\n\s*/g, ' ');

function labelOf(name: string): string {
  return `${name.charAt(0).toUpperCase()}${name.slice(1)}`;
}

/** One line of a reviewer: its mark and note, and under it the finding implement did not fix with the answers to it. */
function reviewerLines(reviewer: ReviewerFact, note: string): string[] {
  const mark = reviewer.decision ? DECISION_MARKS[reviewer.decision] : MISSING;
  const { exchange } = reviewer;
  return [
    `- **${labelOf(reviewer.name)} ${mark}** ${oneLine(note)}`,
    ...(exchange
      ? [
          `  - Finding not fixed: ${oneLine(exchange.finding)}`,
          `  - Implement's reason: ${oneLine(exchange.reason)}`,
          ...(exchange.answer ? [`  - ${labelOf(reviewer.name)} answered: ${oneLine(exchange.answer)}`] : []),
          ...(exchange.decision ? [`  - The person decided: ${oneLine(exchange.decision)}`] : []),
        ]
      : []),
  ];
}

/** The report of a run: the server's facts around the model's parts. The merge request and the dashboard show this text. */
export function renderRunReport(facts: ReportFacts, parts: ReviewReportResult): string {
  const looks = parts.worthALook.map((item, index) => `${index + 1}. \`${item.place}\`: ${oneLine(item.reason)}`);
  const sections = [
    `## ${HEADINGS[facts.verdict]} · risk: ${parts.risk}\n> ${oneLine(parts.line)}`,
    [...tableOf(facts), ...(parts.risk === 'low' ? [] : ['', `**Risk:** ${oneLine(parts.riskReason)}`])].join('\n'),
    ['**Done**', ...parts.done.map((item) => `- ${oneLine(item)}`)].join('\n'),
    ...(looks.length > 0 ? [['**🔍 Worth a look**', ...looks].join('\n')] : []),
    `**🧭 How it got here**\n${facts.path.length > 0 ? facts.path.map(pathText).join(' → ') : MISSING}`,
    [
      `<details><summary>Reviewer notes (${facts.reviewers.length})</summary>`,
      '',
      ...facts.reviewers.flatMap((reviewer) => reviewerLines(reviewer, parts.notes[reviewer.name])),
      '</details>',
    ].join('\n'),
  ];
  return `${sections.join('\n\n')}\n`;
}
