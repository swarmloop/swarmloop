import type { ReviewReportResult } from '../../agent-result/definitions/review-report';

const REPORT_PARTS: [keyof ReviewReportResult, string][] = [
  ['requirements', 'Requirements'],
  ['whatChanged', 'What changed'],
  ['codeReview', 'Code review'],
  ['whatHolds', 'What holds'],
  ['whatToFix', 'What to fix'],
];

/** The `review_report` document and the merge request text: one `## ` section for each part the report gave. */
export function renderReport(result: ReviewReportResult): string {
  const sections = REPORT_PARTS.flatMap(([key, title]) => {
    const text = result[key]?.trim();
    return text ? [`## ${title}\n\n${text}`] : [];
  });
  return `${sections.join('\n\n')}\n`;
}
