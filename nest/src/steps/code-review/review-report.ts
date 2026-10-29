const LABELS: Record<string, string> = {
  review_requirements: 'Requirements',
  review_quality: 'Quality',
  review_regressions: 'Regressions',
  review_security: 'Security',
  review_performance: 'Performance',
};

export function reviewBrief(opinions: { kind: string; decision: 'ok' | 'return'; body: string }[]): string {
  return opinions
    .map((opinion) => {
      const name = LABELS[opinion.kind] ?? opinion.kind.replace(/^review_/, '');
      return [`## ${name}`, `decision: ${opinion.decision}`, '', opinion.body.trimEnd()].join('\n');
    })
    .join('\n\n');
}
