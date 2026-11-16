import type { ReviewReportResult } from '../../agent-result/definitions/review-report';
import type { ReportFacts, ReviewerFact, Verdict } from './report-facts';
import { returnsText, type PathStep } from './report-path';
import { reviewerLabel } from './reviewer-labels';

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

const MINUTE_MS = 60_000;

function durationText(durationMs: number | null): string {
  if (durationMs === null) {
    return MISSING;
  }
  const minutes = Math.round(durationMs / MINUTE_MS);
  return minutes < MINUTES_PER_HOUR
    ? `${minutes} min`
    : `${Math.floor(minutes / MINUTES_PER_HOUR)} h ${minutes % MINUTES_PER_HOUR} min`;
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
    ['Time', durationText(facts.durationMs)],
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

/** The path of a run as one line; a split parent has one line per task. */
function pathLines(facts: ReportFacts): string {
  if (facts.tasks) {
    return facts.tasks.lines.length > 0 ? facts.tasks.lines.map((line) => `- ${line}`).join('\n') : MISSING;
  }
  return facts.path.length > 0 ? facts.path.map(pathText).join(' → ') : MISSING;
}

const oneLine = (text: string): string => text.trim().replace(/\s*\n\s*/g, ' ');

/** One line of a reviewer: its mark and note, and under it the finding implement did not fix with the answers to it. */
function reviewerLines(reviewer: ReviewerFact, note: string): string[] {
  const mark = reviewer.decision ? DECISION_MARKS[reviewer.decision] : MISSING;
  const { exchange } = reviewer;
  return [
    `- **${reviewerLabel(reviewer.name)} ${mark}** ${oneLine(note)}`,
    ...(exchange
      ? [
          `  - Finding not fixed: ${oneLine(exchange.finding)}`,
          `  - Implement's reason: ${oneLine(exchange.reason)}`,
          ...(exchange.answer ? [`  - ${reviewerLabel(reviewer.name)} answered: ${oneLine(exchange.answer)}`] : []),
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
    `**🧭 How it got here**\n${pathLines(facts)}`,
    [
      `<details><summary>Reviewer notes (${facts.reviewers.length})</summary>`,
      '',
      ...facts.reviewers.flatMap((reviewer) => reviewerLines(reviewer, parts.notes[reviewer.name])),
      '</details>',
    ].join('\n'),
  ];
  return `${sections.join('\n\n')}\n`;
}
