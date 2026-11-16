export const REPORT_START = '<!-- swarmloop:report -->';
export const REPORT_END = '<!-- /swarmloop:report -->';

const FLAKY_LINE = /(^|\n)flaky: /;

function marked(report: string): string {
  return `${REPORT_START}\n${report.trim()}\n${REPORT_END}`;
}

/** The positions of the markers, or null when the body has no pair of them. */
function markerSpan(body: string): { from: number; to: number } | null {
  const from = body.indexOf(REPORT_START);
  const end = from < 0 ? -1 : body.indexOf(REPORT_END, from + REPORT_START.length);
  return end < 0 ? null : { from, to: end + REPORT_END.length };
}

/**
 * The body with `report` between the markers. Only the text between them changes. A body with no markers is from
 * before them: its leading swarmloop text, up to the first `flaky:` line, is replaced by the marked report.
 */
export function spliceReport(body: string, report: string): string {
  const span = markerSpan(body);
  if (span) {
    return `${body.slice(0, span.from)}${marked(report)}${body.slice(span.to)}`;
  }
  const flaky = FLAKY_LINE.exec(body);
  const rest = flaky ? body.slice(flaky.index).replace(/^\n+/, '') : '';
  return rest ? `${marked(report)}\n\n${rest}` : marked(report);
}

/** The report between the markers of a body. Null when the body has none. */
export function reportOf(body: string): string | null {
  const span = markerSpan(body);
  return span ? body.slice(span.from + REPORT_START.length, span.to - REPORT_END.length).trim() : null;
}
